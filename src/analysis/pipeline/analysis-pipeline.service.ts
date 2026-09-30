import { Injectable, Logger } from '@nestjs/common'
import { type Analysis, JobErrorCode } from 'adlens-shared'
import { gcsUri } from '../../common/paths'
import type { StoredJob, TokenUsage } from '../../database/job.doc'
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
import { VideoReviewer } from '../review/video-reviewer'
import { ModelAnswerError } from './model-answer-error'
import { isRetryable } from './retryable-error'

// Every Gemini answer is billed, so an unusable one gets a single retry however many attempts Cloud Run has left.
const MAX_ANSWER_ATTEMPTS = 2

export type RunOutcome = 'analyzed' | 'failed' | 'skipped'

export interface RunAttempt {
    isLast: boolean
}

// One worker attempt at a job. A transient failure is rethrown so Cloud Run retries the task, unless this is the last
// attempt; any other failure ends the job in `error` with its charge refunded (after an answer from Gemini, only
// while the network has refunds of those left), and the process exits cleanly.
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

        try {
            const { analysis, usage } = await this.analyze(job)
            const isCompleted = await this.lifecycle.complete(jobId, analysis, usage)

            return isCompleted ? 'analyzed' : 'skipped'
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err)
            const isModelAnswer = err instanceof ModelAnswerError

            if (isModelAnswer) {
                await this.lifecycle.addUsage(jobId, err.usage)
            }

            const isAnswerRetryUsed = isModelAnswer && job.attempts >= MAX_ANSWER_ATTEMPTS

            if (isRetryable(err) && !attempt.isLast && !isAnswerRetryUsed) {
                this.logger.warn(`job ${jobId} failed transiently, leaving it for a retry: ${detail}`)
                throw err
            }

            this.logger.error(`job ${jobId} failed: ${detail}`)
            await this.lifecycle.fail(jobId, JobErrorCode.AnalysisFailed, detail, { isAfterModelAnswer: isModelAnswer })

            return 'failed'
        }
    }

    private async analyze(job: StoredJob): Promise<{ analysis: Analysis; usage: TokenUsage }> {
        if (!job.media) {
            throw new Error('Job has no verified media')
        }

        const ruleSet = await this.ruleset.current()
        const selected = selectRules(ruleSet, job.settings)
        const review = await this.reviewer.review({
            videoUri: gcsUri(job.file.bucket, job.file.path),
            mimeType: job.file.contentType,
            durationS: job.media.durationS,
            rules: projectForModel(selected.content),
            advisories: projectAdvisoriesForModel(selected.advisory),
            settings: job.settings,
        })

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
            usage: review.usage,
        }
    }
}
