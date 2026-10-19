import { Injectable, Logger } from '@nestjs/common'
import { type Analysis, JobErrorCode } from 'adlens-shared'
import { describeError } from '../../common/error-message'
import { gcsUri } from '../../common/paths'
import type { ModelCall, StoredJob } from '../../database/job.doc'
import { JobLifecycle } from '../../jobs/job-lifecycle.service'
import { resolveSettings, selectRules } from '../../rules'
import { RulesetService } from '../../rules/ruleset.service'
import { type VideoReview, VideoReviewer, type VideoReviewRequest } from '../review/video-reviewer'
import { buildAnalysis, toReviewRequest } from './analysis-assembly'
import { isRefusedCall, JobEndedError, ModelAnswerError, ModelCallRepeatedError } from './model-answer-error'
import { isRetryable, RetryableError } from './retryable-error'

type RunOutcome = 'analyzed' | 'failed' | 'skipped'

interface RunAttempt {
    isLast: boolean
}

// The attempt's Gemini call: whether the job holds its mark (from the moment an attempt sets it, or finds it set by an
// earlier one, until a refusal clears it), and the call once Gemini answered, billed whatever becomes of the answer.
interface CallState {
    isMarkKept: boolean
    billed: ModelCall | null
}

// Only the model's own failures (overload, rate limits, its server errors, no answer in time) are RetryableErrors; the
// user is told the AI failed, not the analysis.
const toJobErrorCode = (err: unknown): JobErrorCode =>
    err instanceof RetryableError ? JobErrorCode.ModelUnavailable : JobErrorCode.AnalysisFailed

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

        const state: CallState = { isMarkKept: false, billed: null }

        try {
            const { analysis, call } = await this.analyze(job, state)
            const isCompleted = await this.lifecycle.complete(jobId, analysis, call)

            if (isCompleted) {
                return 'analyzed'
            }

            // The job ended meanwhile (it expired as stale), but Gemini billed the call all the same.
            await this.lifecycle.addUsage(jobId, call)

            return 'skipped'
        } catch (err) {
            const detail = describeError(err)

            if (err instanceof JobEndedError) {
                this.logger.warn(`job ${jobId} ended before its model call; nothing to do`)
                return 'skipped'
            }

            // A billed call whose answer couldn't be used, assembled or stored still belongs in the cost ledger.
            const billed = err instanceof ModelAnswerError ? err.call : state.billed

            if (billed) {
                await this.tryAddUsage(jobId, billed)
            }

            if (isRetryable(err) && !attempt.isLast && !state.isMarkKept) {
                this.logger.warn(`job ${jobId} failed transiently, leaving it for a retry: ${detail}`)
                throw err
            }

            const isFailed = await this.lifecycle.fail(jobId, toJobErrorCode(err), detail)

            // Already ended, stored after all (its acknowledgement was lost) or expired by the sweep: not an error to
            // report.
            if (!isFailed) {
                this.logger.warn(`job ${jobId} had already ended when its attempt failed: ${detail}`)
                return 'skipped'
            }

            this.logger.error(`job ${jobId} failed: ${detail}`)

            return 'failed'
        }
    }

    private async analyze(job: StoredJob, state: CallState): Promise<{ analysis: Analysis; call: ModelCall }> {
        if (!job.media) {
            throw new Error('Job has no verified media')
        }

        const jobId = job._id.toString()
        const ruleSet = await this.ruleset.current()
        const selected = selectRules(ruleSet, job.settings)
        const marking = await this.lifecycle.markModelCall(jobId)

        if (marking === 'ended') {
            throw new JobEndedError()
        }

        state.isMarkKept = true

        if (marking === 'repeated') {
            throw new ModelCallRepeatedError()
        }

        const review = await this.review(
            jobId,
            toReviewRequest(
                { videoUri: gcsUri(job.file.bucket, job.file.path), mimeType: job.file.contentType },
                job.media,
                job.settings,
                selected,
            ),
            state,
        )

        state.billed = review.call

        return {
            analysis: buildAnalysis(ruleSet, selected, review, job.media, resolveSettings(job.settings)),
            call: review.call,
        }
    }

    private async review(jobId: string, request: VideoReviewRequest, state: CallState): Promise<VideoReview> {
        try {
            return await this.reviewer.review(request)
        } catch (err) {
            // Only a refusal is certainly unbilled. After a timeout or a dropped connection Vertex may still have
            // generated, and billed, an answer, so the mark stays and no attempt calls again.
            if (isRefusedCall(err)) {
                await this.lifecycle.clearModelCall(jobId)
                state.isMarkKept = false
            }

            throw err
        }
    }

    // Best-effort: failing to record the cost must not stop the job from failing and being refunded.
    private async tryAddUsage(jobId: string, call: ModelCall): Promise<void> {
        try {
            await this.lifecycle.addUsage(jobId, call)
        } catch (err) {
            this.logger.error(`could not record the billed call of job ${jobId}: ${describeError(err)}`)
        }
    }
}
