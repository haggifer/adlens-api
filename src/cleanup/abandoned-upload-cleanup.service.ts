import { Injectable, Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { JobStatus } from 'adlens-shared'
import { Model } from 'mongoose'
import { JOB_MODEL, type JobDoc, type StoredJob } from '../database/job.doc'
import { StorageService } from '../storage/storage.service'
import type { CleanupResult } from './types'

// Far past the signed upload URL's lifetime and every in-flight timeout, so no upload or analysis still needs it.
export const UNUSED_VIDEO_MS = 6 * 60 * 60 * 1000

// Deletes the videos that back no results: a video is kept only while its analysis succeeded, because every finding's
// timestamp seeks the replay. That covers jobs never started (pending), failed or rejected (error), and stale ones
// that never left verifying, queued or analyzing. Every uploaded object belongs to a job (its path is made from the
// user and job ids at creation), so the jobs find them all. The job stays, marked `videoDeletedAt`, so it is handled
// once, while a failed or missed run is caught up the next day; analyzing it later answers UPLOAD_INCOMPLETE. A
// sample job's path is the shared sample video, which is never deleted.
@Injectable()
export class AbandonedUploadCleanupService {
    private readonly logger = new Logger(AbandonedUploadCleanupService.name)

    constructor(
        @InjectModel(JOB_MODEL) private readonly jobs: Model<JobDoc>,
        private readonly storage: StorageService,
    ) {}

    async run(now = new Date()): Promise<CleanupResult> {
        const cutoff = new Date(now.getTime() - UNUSED_VIDEO_MS)
        const unused = await this.jobs
            .find(
                {
                    status: { $ne: JobStatus.Analyzed },
                    sampleId: { $exists: false },
                    videoDeletedAt: { $exists: false },
                    updatedAt: { $lt: cutoff },
                },
                { 'file.path': 1 },
            )
            .lean<Pick<StoredJob, '_id' | 'file'>[]>()
        const result: CleanupResult = { deleted: 0, failed: 0 }

        for (const { _id, file } of unused) {
            try {
                // Deleted before the mark, so a failure between the two leaves the job for the next run.
                await this.storage.delete(file.path)
                await this.jobs.updateOne({ _id }, { $set: { videoDeletedAt: now } })
                result.deleted++
            } catch (err) {
                result.failed++
                this.logger.error(
                    `could not delete the video of job ${_id.toString()}: ${err instanceof Error ? err.message : err}`,
                )
            }
        }

        this.logger.log(
            `deleted the videos of ${result.deleted} jobs not analyzed since before ${cutoff.toISOString()}`,
        )

        return result
    }
}
