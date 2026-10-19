import { Injectable, Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { JOB_START_WINDOW_MS, JobStatus } from 'adlens-shared'
import { type FilterQuery, Model, type Types } from 'mongoose'
import { describeError } from '../common/error-message'
import { JOB_MODEL, type JobDoc, type StoredJob } from '../database/job.doc'
import { IN_PROGRESS_STATUSES } from '../jobs/job-status'
import { StorageService } from '../storage/storage.service'
import type { CleanupResult } from './types'

// A video no result needs: its job ended without one, wasn't restarted, and the video isn't deleted yet.
const UNUSED_VIDEO: FilterQuery<JobDoc> = {
    status: { $nin: [JobStatus.Analyzed, ...IN_PROGRESS_STATUSES] },
    restartedAs: { $exists: false },
    videoDeletedAt: { $exists: false },
}

// Deletes the videos that back no results: a video is kept only while its analysis succeeded, because every finding's
// timestamp seeks the replay, or while its failed job may still be restarted (JOB_START_WINDOW_MS). That covers failed,
// rejected and never started jobs (error), and a pending one the expiry couldn't end. A job in progress keeps its
// video: the cleanup expires abandoned jobs first, so one still in progress here is running. A restarted job's video is
// its restart's, which the cleanup judges on its own. Jobs are aged from their creation, not their last update, so a
// job that just ended (by this very run's expiry, say) loses its video now rather than a day later. Every uploaded
// object belongs to a job (its path is made from the user and job ids at creation), so the jobs find them all. Each
// video is claimed first (`videoDeletingAt`, one conditional write that a restart's own claim excludes), then
// deleted, then marked `videoDeletedAt`; the job stays, so it is handled once, while a failed or missed run is caught
// up the next day. A sample job's path is the shared sample video, which is never deleted.
@Injectable()
export class AbandonedUploadCleanupService {
    private readonly logger = new Logger(AbandonedUploadCleanupService.name)

    constructor(
        @InjectModel(JOB_MODEL) private readonly jobs: Model<JobDoc>,
        private readonly storage: StorageService,
    ) {}

    async run(now = new Date()): Promise<CleanupResult> {
        const cutoff = new Date(now.getTime() - JOB_START_WINDOW_MS)
        const unused = await this.findUnusedVideos(cutoff)
        const result: CleanupResult = { deleted: 0, failed: 0 }

        for (const { _id, file } of unused) {
            try {
                const isClaimed = await this.claim(_id, now)

                // Restarted since it was found: the video now backs the restart.
                if (!isClaimed) {
                    continue
                }

                // A failure from here leaves the claim in place, so the next run tries again and no restart starts.
                await this.storage.delete(file.path)
                await this.jobs.updateOne({ _id }, { $set: { videoDeletedAt: now }, $unset: { videoDeletingAt: 1 } })
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
                    ...UNUSED_VIDEO,
                    sampleId: { $exists: false },
                    // A demo's video is the maintainer's, under demos/: a demo that failed keeps it for the re-run.
                    demo: { $exists: false },
                    createdAt: { $lt: cutoff },
                },
                { 'file.path': 1 },
            )
            .lean<Pick<StoredJob, '_id' | 'file'>[]>()
    }

    private async claim(jobId: Types.ObjectId, now: Date): Promise<boolean> {
        const claimed = await this.jobs.updateOne({ _id: jobId, ...UNUSED_VIDEO }, { $set: { videoDeletingAt: now } })

        return claimed.modifiedCount > 0
    }
}
