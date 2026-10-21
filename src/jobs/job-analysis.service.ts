import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { type ApiError, type Job, JobErrorCode, type JobMedia, RequestErrorCode } from 'adlens-shared'
import { AnalysisDispatcher } from '../analysis/dispatch/analysis-dispatcher'
import { ApiException } from '../common/api-exception'
import { describeError } from '../common/error-message'
import type { StoredJob } from '../database/job.doc'
import type { IpSource } from '../ip-quota/client-ip'
import { PresetsService } from '../presets/presets.service'
import { SamplesService } from '../samples/samples.service'
import { StorageService } from '../storage/storage.service'
import { AnalysisAdmission } from './analysis-admission.service'
import { JobLifecycle } from './job-lifecycle.service'
import { toPublicJob } from './job.mapper'
import { JobsService } from './jobs.service'
import { VideoVerifier } from './verification/video-verifier.service'

const REJECTION_MESSAGES: Record<JobErrorCode, string> = {
    [JobErrorCode.VideoUnreadable]: 'The upload is not a readable video',
    [JobErrorCode.VideoTooLong]: 'The video is longer than allowed',
    [JobErrorCode.VideoTooLarge]: 'The video file is larger than allowed',
    [JobErrorCode.UnsupportedFormat]: 'The video format is not supported',
    [JobErrorCode.AnalysisFailed]: 'The analysis failed',
    [JobErrorCode.AnalysisTimedOut]: 'The analysis timed out',
    [JobErrorCode.ModelUnavailable]: 'The AI model failed',
    [JobErrorCode.VideoCheckFailed]: 'The upload could not be checked',
    [JobErrorCode.UploadFailed]: 'The upload has not finished',
}

// The refusal's own code (e.g. QUOTA_EXCEEDED), never another error's message: a MongoDB error quotes the key it hit,
// and a job must never hold a network key.
const describeChargeFailure = (err: unknown) => {
    const response = err instanceof ApiException ? (err.getResponse() as ApiError) : null

    return `The run could not be charged: ${response?.errorCode ?? 'unexpected error'}`
}

// POST /v1/jobs/:id/analyze. Claims the pending job, verifies the upload, charges the network and the user, and starts
// the worker. A step that can't complete ends the job in error with any charge refunded: the web never starts a job
// twice (it creates a new one), so the job never goes back to pending.
@Injectable()
export class JobAnalysisService {
    private readonly logger = new Logger(JobAnalysisService.name)

    constructor(
        private readonly jobs: JobsService,
        private readonly lifecycle: JobLifecycle,
        private readonly verifier: VideoVerifier,
        private readonly storage: StorageService,
        private readonly dispatcher: AnalysisDispatcher,
        private readonly samples: SamplesService,
        private readonly admission: AnalysisAdmission,
        private readonly presets: PresetsService,
    ) {}

    async start(userId: string, jobId: string, ipSource: IpSource, freeRunUserId: string | null): Promise<Job> {
        const claimed = await this.lifecycle.claimForVerification(userId, jobId)

        if (!claimed) {
            await this.jobs.findOwned(userId, jobId)
            throw new ApiException(HttpStatus.CONFLICT, RequestErrorCode.JobNotPending, 'Job is not pending')
        }

        const media = await this.verifyVideo(claimed)
        const queued = await this.queueRun(userId, claimed, media, ipSource, freeRunUserId)

        // Kept only when the worker dispatched at creation is certain to take the job (chargeAndQueue).
        if (!queued.workerWaitsUntil) {
            const execution = await this.startWorker(jobId)

            if (execution) {
                await this.tryRecordExecution(jobId, execution)
            }
        }

        const presetId = await this.countPresetUse(userId, queued)

        return toPublicJob({ ...queued, presetId })
    }

    // Right after an upload job is created, so the worker's provisioning overlaps the upload. The job already holds
    // its deadline (JobsService.create): if the API died after dispatching, the start must not dispatch a second
    // worker, and the worst case is a job no worker took, which the stale sweep fails and refunds. A failed dispatch
    // never fails the creation: the start then dispatches as for any other job.
    async startEarlyWorker(jobId: string): Promise<void> {
        let execution: string | null

        try {
            execution = await this.dispatcher.dispatch(jobId, { isEarly: true })
        } catch (err) {
            this.logger.error(`early dispatch failed for job ${jobId}: ${describeError(err)}`)
            await this.tryCancelEarlyWorker(jobId)

            return
        }

        if (execution) {
            await this.tryRecordExecution(jobId, execution)
        }
    }

    // POST /v1/jobs/:id/restart: a new job on the failed job's video (JobsService.createRestart), started like any other.
    // The refusals the run would meet come first, so a refused restart changes nothing.
    async restart(userId: string, jobId: string, ipSource: IpSource, freeRunUserId: string | null): Promise<Job> {
        const failed = await this.jobs.findOwned(userId, jobId)

        await this.admission.preview(userId, ipSource, freeRunUserId)

        const restarted = await this.jobs.createRestart(failed)

        // Only now, so an open page of the failed job moves to its restart once the run has started, or failed.
        try {
            return await this.start(userId, restarted._id.toString(), ipSource, freeRunUserId)
        } finally {
            await this.jobs.announceRestart(failed)
        }
    }

    private verifyVideo(job: StoredJob): Promise<JobMedia> {
        return job.sampleId ? this.verifySample(job) : this.verifyUpload(job)
    }

    private async queueRun(
        userId: string,
        job: StoredJob,
        media: JobMedia,
        ipSource: IpSource,
        freeRunUserId: string | null,
    ): Promise<StoredJob> {
        const jobId = job._id.toString()

        try {
            // Jobs created before the field existed have none: they get no pass.
            const ipCharge = await this.admission.ipChargeFor(
                userId,
                ipSource,
                Boolean(job.hasPassedChallenge),
                freeRunUserId,
            )
            return await this.lifecycle.chargeAndQueue(jobId, userId, media, ipCharge, job.workerWaitsUntil)
        } catch (err) {
            // No JobErrorCode names a refusal (the request's own code tells the user why); the detail keeps it.
            await this.lifecycle.failStart(jobId, JobErrorCode.AnalysisFailed, describeChargeFailure(err))
            throw err
        }
    }

    // A run counts for its preset once its worker started (a failed start refunds the run), whatever the analysis then
    // ends as, and only when its settings still match the preset; counting never fails the run. A restart of a counted
    // run carries its preset over and isn't counted again. Answers the preset id stored on the job, or null.
    private async countPresetUse(userId: string, job: StoredJob): Promise<string | null> {
        const presetId = job.appliedPresetId

        if (job.presetId) {
            return job.presetId
        }

        if (!presetId) {
            return null
        }

        try {
            const isCounted = await this.presets.recordUse(userId, presetId, job.settings)

            if (!isCounted) {
                return null
            }

            await this.jobs.recordCountedPreset(job, presetId)

            return presetId
        } catch (err) {
            this.logger.error(`could not count preset ${presetId} for job ${job._id.toString()}: ${describeError(err)}`)

            return null
        }
    }

    // The worker is running, so the request is answered as if this succeeded: the execution name only helps find the
    // worker's logs.
    private async tryRecordExecution(jobId: string, execution: string): Promise<void> {
        try {
            await this.lifecycle.recordExecution(jobId, execution)
        } catch (err) {
            this.logger.error(`could not record execution ${execution} of job ${jobId}: ${describeError(err)}`)
        }
    }

    // Left in place, the deadline makes the start leave the job to a worker that never came: it stays queued until the
    // stale sweep fails and refunds it.
    private async tryCancelEarlyWorker(jobId: string): Promise<void> {
        try {
            await this.lifecycle.cancelEarlyWorker(jobId)
        } catch (err) {
            this.logger.error(`could not cancel the early worker of job ${jobId}: ${describeError(err)}`)
        }
    }

    private async startWorker(jobId: string): Promise<string | null> {
        try {
            return await this.dispatcher.dispatch(jobId)
        } catch (err) {
            this.logger.error(`dispatch failed for job ${jobId}: ${describeError(err)}`)
            await this.lifecycle.failDispatch(jobId)
            throw new ApiException(
                HttpStatus.SERVICE_UNAVAILABLE,
                RequestErrorCode.Unavailable,
                'The analysis could not be started',
            )
        }
    }

    // A sample was measured when it was published, so its job skips verification; the one check is that a published
    // sample still points at the job's video.
    private async verifySample(job: StoredJob): Promise<JobMedia> {
        const isPublished = await this.samples.isPublishedPath(job.file.path)

        if (!isPublished || !job.media) {
            await this.lifecycle.failStart(
                job._id.toString(),
                JobErrorCode.VideoCheckFailed,
                'The sample is no longer published',
            )
            throw new ApiException(HttpStatus.NOT_FOUND, RequestErrorCode.NotFound, 'Sample not found')
        }

        return job.media
    }

    private async verifyUpload(job: StoredJob): Promise<JobMedia> {
        const jobId = job._id.toString()
        const outcome = await this.verifier.verify(job.file.path)

        switch (outcome.kind) {
            case 'verified':
                return outcome.media
            // Neither deletes the user's file: the daily cleanup deletes the video of an error job.
            case 'upload-incomplete':
                await this.lifecycle.failStart(jobId, JobErrorCode.UploadFailed, 'No upload when the run started')
                throw new ApiException(
                    HttpStatus.CONFLICT,
                    RequestErrorCode.UploadIncomplete,
                    'The upload has not finished',
                )
            case 'unavailable':
                await this.lifecycle.failStart(
                    jobId,
                    JobErrorCode.VideoCheckFailed,
                    'Storage or the prober failed during verification',
                )
                throw new ApiException(
                    HttpStatus.SERVICE_UNAVAILABLE,
                    RequestErrorCode.Unavailable,
                    'The upload could not be checked',
                )
            case 'rejected':
                await this.lifecycle.failStart(jobId, outcome.errorCode)
                await this.tryDeleteUpload(jobId, job.file.path)
                throw new ApiException(
                    HttpStatus.UNPROCESSABLE_ENTITY,
                    outcome.errorCode,
                    REJECTION_MESSAGES[outcome.errorCode],
                )
        }
    }

    // The user still learns why the video was refused; the daily cleanup deletes an error job's video later.
    private async tryDeleteUpload(jobId: string, path: string): Promise<void> {
        try {
            await this.storage.delete(path)
        } catch (err) {
            this.logger.error(`could not delete the rejected upload of job ${jobId}: ${describeError(err)}`)
        }
    }
}
