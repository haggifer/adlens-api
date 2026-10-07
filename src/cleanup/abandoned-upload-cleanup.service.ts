import { Injectable, Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { JobStatus } from 'adlens-shared'
import { Model } from 'mongoose'
import { describeError } from '../common/error-message'
import { JOB_MODEL, type JobDoc, type StoredJob } from '../database/job.doc'
import { IN_PROGRESS_STATUSES, UNSTARTED_JOB_MS } from '../jobs/job-status'
import { StorageService } from '../storage/storage.service'
import type { CleanupResult } from './types'

// Deletes the videos that back no results: a video is kept only while its analysis succeeded, because every finding's
// timestamp seeks the replay. That covers failed, rejected and never started jobs (error), and a pending one the
// expiry couldn't end. A job in progress keeps its video: the cleanup expires abandoned jobs first, so one still in
// progress here is running. Jobs are aged from their creation, not their last update, so a job that just ended (by
// this very run's expiry, say) loses its video now rather than a day later. Every uploaded object belongs to a job
// (its path is made from the user and job ids at creation), so the jobs find them all. The job stays, marked
// `videoDeletedAt`, so it is handled once, while a failed or missed run is caught up the next day. A sample job's path
// is the shared sample video, which is never deleted.
@Injectable()
export class AbandonedUploadCleanupService {
    private readonly logger = new Logger(AbandonedUploadCleanupService.name)

    constructor(
        @InjectModel(JOB_MODEL) private readonly jobs: Model<JobDoc>,
        private readonly storage: StorageService,
    ) {}

    async run(now = new Date()): Promise<CleanupResult> {
        const cutoff = new Date(now.getTime() - UNSTARTED_JOB_MS)
        const unused = await this.findUnusedVideos(cutoff)
        const result: CleanupResult = { deleted: 0, failed: 0 }

        for (const { _id, file } of unused) {
            try {
                // Deleted before the mark, so a failure between the two leaves the job for the next run.
                await this.storage.delete(file.path)
                await this.jobs.updateOne({ _id }, { $set: { videoDeletedAt: now } })
                result.deleted++
            } catch (err) {
                result.failed++
                this.logger.error(`could not delete the video of job ${_id.toString()}: ${describeError(err)}`)
            }
        }

        this.logger.log(
            `deleted the videos of ${result.deleted} ended jobs, not analyzed, created before ${cutoff.toISOString()}`,
        )

        return result
    }

    private findUnusedVideos(cutoff: Date): Promise<Pick<StoredJob, '_id' | 'file'>[]> {
        return this.jobs
            .find(
                {
                    status: { $nin: [JobStatus.Analyzed, ...IN_PROGRESS_STATUSES] },
                    sampleId: { $exists: false },
                    // A demo's video is the maintainer's, under demos/: a demo that failed keeps it for the re-run.
                    demo: { $exists: false },
                    videoDeletedAt: { $exists: false },
                    createdAt: { $lt: cutoff },
                },
                { 'file.path': 1 },
            )
            .lean<Pick<StoredJob, '_id' | 'file'>[]>()
    }
}
