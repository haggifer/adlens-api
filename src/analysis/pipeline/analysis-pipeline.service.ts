import { Injectable, Logger } from '@nestjs/common'
import { type Analysis, JobErrorCode } from 'adlens-shared'
import { gcsUri } from '../../common/paths'
import type { ModelCall, StoredJob } from '../../database/job.doc'
import { JobLifecycle } from '../../jobs/job-lifecycle.service'
import {
    buildAdvisories,
    buildFindings,
    evaluateMetadataRules,
    projectAdvisoriesForModel,
    projectForModel,
    selectRules,
} from '../../rules'
import { RulesetService } from '../../rules/ruleset.service'
import { type VideoReview, VideoReviewer } from '../review/video-reviewer'
import { isRefusedCall, ModelAnswerError, ModelCallRepeatedError } from './model-answer-error'
import { isRetryable } from './retryable-error'

export type RunOutcome = 'analyzed' | 'failed' | 'skipped'

export interface RunAttempt {
    isLast: boolean
}

// Whether the job holds the Gemini call mark: from the moment an attempt sets it (or finds it set by an earlier one)
// until a refusal clears it.
interface CallMark {
    isKept: boolean
}

// One worker attempt at a job. A transient failure is rethrown so Cloud Run retries the task, unless this is the last
// attempt or the job holds the call mark (a retry could only refuse to call Gemini again); any other failure ends the
// job in `error` with its charge refunded (after a call that may have been billed, only while the network has refunds
// of those left), and the process exits cleanly. A job is never billed twice: Gemini is called at most once per job,
// unless Vertex refused the call with an HTTP error status.
@Injectable()
export class AnalysisPipeline {
    private readonly logger = new Logger(AnalysisPipeline.name)

    constructor(
        private readonly lifecycle: JobLifecycle,
        private readonly reviewer: VideoReviewer,
        private readonly ruleset: RulesetService,
    ) {}

    async run(jobId: string, attempt: RunAttempt): Promise<RunOutcome> {
        const job = await this.lifecycle.startAttempt(jobId)

        if (!job) {
            this.logger.warn(`job ${jobId} is not in flight; nothing to do`)
            return 'skipped'
        }

        const mark: CallMark = { isKept: false }

        try {
            const { analysis, call } = await this.analyze(job, mark)
            const isCompleted = await this.lifecycle.complete(jobId, analysis, call)

            return isCompleted ? 'analyzed' : 'skipped'
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err)

            if (err instanceof ModelAnswerError) {
                await this.lifecycle.addUsage(jobId, err.call)
            }

            if (isRetryable(err) && !attempt.isLast && !mark.isKept) {
                this.logger.warn(`job ${jobId} failed transiently, leaving it for a retry: ${detail}`)
                throw err
            }

            this.logger.error(`job ${jobId} failed: ${detail}`)
            // A kept mark means a call that may have been billed (answered, timed out, dropped, failed unknowably, or
            // made by an earlier attempt), so its refund counts against the network's allowance however it failed.
            await this.lifecycle.fail(jobId, JobErrorCode.AnalysisFailed, detail, { isPossiblyBilled: mark.isKept })

            return 'failed'
        }
    }

    private async analyze(job: StoredJob, mark: CallMark): Promise<{ analysis: Analysis; call: ModelCall }> {
        if (!job.media) {
            throw new Error('Job has no verified media')
        }

        const ruleSet = await this.ruleset.current()
        const selected = selectRules(ruleSet, job.settings)
        const jobId = job._id.toString()
        const isMarked = await this.lifecycle.markModelCall(jobId)

        mark.isKept = true

        if (!isMarked) {
            throw new ModelCallRepeatedError()
        }

        let review: VideoReview

        try {
            review = await this.reviewer.review({
                videoUri: gcsUri(job.file.bucket, job.file.path),
                mimeType: job.file.contentType,
                durationS: job.media.durationS,
                rules: projectForModel(selected.content),
                advisories: projectAdvisoriesForModel(selected.advisory),
                settings: job.settings,
            })
        } catch (err) {
            // Only a refusal is certainly unbilled. After a timeout or a dropped connection Vertex may still have
            // generated, and billed, an answer, so the mark stays and no attempt calls again.
            if (isRefusedCall(err)) {
                await this.lifecycle.clearModelCall(jobId)
                mark.isKept = false
            }

            throw err
        }

        return {
            analysis: {
                model: review.model,
                promptVersion: review.promptVersion,
                rulesetVersion: ruleSet.meta.version,
                transcript: review.transcript,
                findings: buildFindings(ruleSet, selected.content, review.findings),
                metadataChecks: evaluateMetadataRules(ruleSet, selected.metadata, job.media),
                advisories: buildAdvisories(
                    ruleSet,
                    selected.advisory.filter((rule) => review.advisoryIds.includes(rule.id)),
                ),
                completedAt: new Date().toISOString(),
            },
            call: review.call,
        }
    }
}
