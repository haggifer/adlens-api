import { Injectable, Logger } from '@nestjs/common'
import { type Analysis, type AnalysisSettings, JobErrorCode, type JobMedia } from 'adlens-shared'
import { describeError } from '../../common/error-message'
import { gcsUri } from '../../common/paths'
import type { ModelCall, StoredJob } from '../../database/job.doc'
import { JobLifecycle } from '../../jobs/job-lifecycle.service'
import {
    buildAdvisories,
    buildFindings,
    evaluateMetadataRules,
    projectAdvisoriesForModel,
    projectForModel,
    resolveSettings,
    type SelectedRules,
    selectRules,
} from '../../rules'
import { RulesetService } from '../../rules/ruleset.service'
import type { RuleSet } from '../../rules/schema'
import { type VideoReview, VideoReviewer, type VideoReviewRequest } from '../review/video-reviewer'
import { isRefusedCall, ModelAnswerError, ModelCallRepeatedError } from './model-answer-error'
import { isRetryable } from './retryable-error'

type RunOutcome = 'analyzed' | 'failed' | 'skipped'

interface RunAttempt {
    isLast: boolean
}

// Whether the job holds the Gemini call mark: from the moment an attempt sets it (or finds it set by an earlier one)
// until a refusal clears it.
interface CallMark {
    isKept: boolean
}

const toReviewRequest = (job: StoredJob, media: JobMedia, selected: SelectedRules): VideoReviewRequest => ({
    videoUri: gcsUri(job.file.bucket, job.file.path),
    mimeType: job.file.contentType,
    durationS: media.durationS,
    rules: projectForModel(selected.content),
    advisories: projectAdvisoriesForModel(selected.advisory),
    settings: job.settings,
})

const buildAnalysis = (
    ruleSet: RuleSet,
    selected: SelectedRules,
    review: VideoReview,
    media: JobMedia,
    settings: AnalysisSettings,
): Analysis => ({
    model: review.model,
    promptVersion: review.promptVersion,
    rulesetVersion: ruleSet.meta.version,
    transcript: review.transcript,
    findings: buildFindings(ruleSet, selected.content, review.findings),
    metadataChecks: evaluateMetadataRules(ruleSet, selected.metadata, media, settings.placements, settings.platforms),
    advisories: buildAdvisories(
        ruleSet,
        selected.advisory.filter((rule) => review.advisoryIds.includes(rule.id)),
    ),
    completedAt: new Date().toISOString(),
})

// One worker attempt at a job. A transient failure is rethrown so Cloud Run retries the task, unless this is the last
// attempt or the job holds the call mark (a retry could only refuse to call Gemini again); any other failure ends the
// job in `error` with its charges refunded in full, even after a call that may have been billed, and the process exits
// cleanly. A job is never billed twice: Gemini is called at most once per job, unless Vertex refused the call with an
// HTTP error status.
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

            if (isCompleted) {
                return 'analyzed'
            }

            // The job ended meanwhile (it expired as stale), but Gemini billed the call all the same.
            await this.lifecycle.addUsage(jobId, call)

            return 'skipped'
        } catch (err) {
            const detail = describeError(err)

            if (err instanceof ModelAnswerError) {
                await this.lifecycle.addUsage(jobId, err.call)
            }

            if (isRetryable(err) && !attempt.isLast && !mark.isKept) {
                this.logger.warn(`job ${jobId} failed transiently, leaving it for a retry: ${detail}`)
                throw err
            }

            this.logger.error(`job ${jobId} failed: ${detail}`)
            await this.lifecycle.fail(jobId, JobErrorCode.AnalysisFailed, detail)

            return 'failed'
        }
    }

    private async analyze(job: StoredJob, mark: CallMark): Promise<{ analysis: Analysis; call: ModelCall }> {
        if (!job.media) {
            throw new Error('Job has no verified media')
        }

        const jobId = job._id.toString()
        const ruleSet = await this.ruleset.current()
        const selected = selectRules(ruleSet, job.settings)
        const isMarked = await this.lifecycle.markModelCall(jobId)

        mark.isKept = true

        if (!isMarked) {
            throw new ModelCallRepeatedError()
        }

        const review = await this.review(jobId, toReviewRequest(job, job.media, selected), mark)

        return {
            analysis: buildAnalysis(ruleSet, selected, review, job.media, resolveSettings(job.settings)),
            call: review.call,
        }
    }

    private async review(jobId: string, request: VideoReviewRequest, mark: CallMark): Promise<VideoReview> {
        try {
            return await this.reviewer.review(request)
        } catch (err) {
            // Only a refusal is certainly unbilled. After a timeout or a dropped connection Vertex may still have
            // generated, and billed, an answer, so the mark stays and no attempt calls again.
            if (isRefusedCall(err)) {
                await this.lifecycle.clearModelCall(jobId)
                mark.isKept = false
            }

            throw err
        }
    }
}
