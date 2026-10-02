import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { type ApiError, JobErrorCode, type Job, type JobMedia, RequestErrorCode } from 'adlens-shared'
import { AnalysisDispatcher } from '../analysis/dispatch/analysis-dispatcher'
import { ApiException } from '../common/api-exception'
import type { StoredJob } from '../database/job.doc'
import type { IpSource } from '../ip-quota/client-ip'
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
    ) {}

    async start(userId: string, jobId: string, ipSource: IpSource): Promise<Job> {
        const claimed = await this.lifecycle.claimForVerification(userId, jobId)

        if (!claimed) {
            await this.jobs.findOwned(userId, jobId)
            throw new ApiException(HttpStatus.CONFLICT, RequestErrorCode.JobNotPending, 'Job is not pending')
        }

        const media = claimed.sampleId ? await this.checkSample(claimed) : await this.verifyUpload(claimed)

        let queued: StoredJob

        try {
            // Jobs created before the field existed have none: they get no pass.
            const ipCharge = await this.admission.ipChargeFor(userId, ipSource, Boolean(claimed.hasPassedChallenge))

            queued = await this.lifecycle.chargeAndQueue(jobId, userId, media, ipCharge)
        } catch (err) {
            // No JobErrorCode names a refusal (the request's own code tells the user why); the detail keeps it.
            await this.lifecycle.failStart(jobId, JobErrorCode.AnalysisFailed, describeChargeFailure(err))
            throw err
        }

        let execution: string | null

        try {
            execution = await this.dispatcher.dispatch(jobId)
        } catch (err) {
            this.logger.error(`dispatch failed for job ${jobId}: ${err instanceof Error ? err.message : err}`)
            await this.lifecycle.failDispatch(jobId)
            throw new ApiException(
                HttpStatus.SERVICE_UNAVAILABLE,
                RequestErrorCode.Unavailable,
                'The analysis could not be started',
            )
        }

        if (execution) {
            await this.lifecycle.recordExecution(jobId, execution)
        }

        return toPublicJob(queued)
    }

    // A sample was measured when it was published, so its job skips verification; the one check is that a published
    // sample still points at the job's video.
    private async checkSample(job: StoredJob): Promise<JobMedia> {
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
                await this.storage.delete(job.file.path)
                throw new ApiException(
                    HttpStatus.UNPROCESSABLE_ENTITY,
                    outcome.errorCode,
                    REJECTION_MESSAGES[outcome.errorCode],
                )
        }
    }
}
