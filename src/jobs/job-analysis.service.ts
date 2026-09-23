import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { JobErrorCode, type Job, RequestErrorCode } from 'adlens-shared'
import { AnalysisDispatcher } from '../analysis/dispatch/analysis-dispatcher'
import { ApiException } from '../common/api-exception'
import type { StoredJob } from '../database/job.doc'
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
    ) {}

    async start(userId: string, jobId: string): Promise<Job> {
        const claimed = await this.lifecycle.claimForVerification(userId, jobId)

        if (!claimed) {
            await this.jobs.findOwned(userId, jobId)
            throw new ApiException(HttpStatus.CONFLICT, RequestErrorCode.JobNotPending, 'Job is not pending')
        }

        const outcome = await this.verifier.verify(claimed.file.path)

        switch (outcome.kind) {
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
                await this.storage.delete(claimed.file.path)
                throw new ApiException(
                    HttpStatus.UNPROCESSABLE_ENTITY,
                    outcome.errorCode,
                    REJECTION_MESSAGES[outcome.errorCode],
                )
        }

        let queued: StoredJob

        try {
            queued = await this.lifecycle.chargeAndQueue(jobId, userId, outcome.media)
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
}
