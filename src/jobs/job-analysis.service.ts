import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { JobErrorCode, type Job, type JobMedia, RequestErrorCode } from 'adlens-shared'
import { AnalysisDispatcher } from '../analysis/dispatch/analysis-dispatcher'
import { ApiException } from '../common/api-exception'
import type { StoredJob } from '../database/job.doc'
import { SamplesService } from '../samples/samples.service'
import { StorageService } from '../storage/storage.service'
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
}

// POST /v1/jobs/:id/analyze. Claims the pending job, verifies the upload, charges one run and starts the worker.
// Each step that can't complete puts the job back where the user can retry it, with any charge refunded.
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
    ) {}

    async start(userId: string, jobId: string): Promise<Job> {
        const claimed = await this.lifecycle.claimForVerification(userId, jobId)

        if (!claimed) {
            await this.jobs.findOwned(userId, jobId)
            throw new ApiException(HttpStatus.CONFLICT, RequestErrorCode.JobNotPending, 'Job is not pending')
        }

        const media = claimed.sampleId ? await this.checkSample(claimed) : await this.verifyUpload(claimed)

        let queued: StoredJob

        try {
            queued = await this.lifecycle.chargeAndQueue(jobId, userId, media)
        } catch (err) {
            await this.lifecycle.releaseVerification(jobId)
            throw err
        }

        let execution: string | null

        try {
            execution = await this.dispatcher.dispatch(jobId)
        } catch (err) {
            this.logger.error(`dispatch failed for job ${jobId}: ${err instanceof Error ? err.message : err}`)
            await this.lifecycle.revertDispatch(jobId)
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
            await this.lifecycle.releaseVerification(job._id.toString())
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
            case 'upload-incomplete':
                await this.lifecycle.releaseVerification(jobId)
                throw new ApiException(
                    HttpStatus.CONFLICT,
                    RequestErrorCode.UploadIncomplete,
                    'The upload has not finished',
                )
            case 'unavailable':
                await this.lifecycle.releaseVerification(jobId)
                throw new ApiException(
                    HttpStatus.SERVICE_UNAVAILABLE,
                    RequestErrorCode.Unavailable,
                    'The upload could not be checked',
                )
            case 'rejected':
                await this.lifecycle.rejectVerification(jobId, outcome.errorCode)
                await this.storage.delete(job.file.path)
                throw new ApiException(
                    HttpStatus.UNPROCESSABLE_ENTITY,
                    outcome.errorCode,
                    REJECTION_MESSAGES[outcome.errorCode],
                )
        }
    }
}
