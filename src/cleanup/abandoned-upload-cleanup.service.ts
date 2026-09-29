import { Injectable, Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { JobStatus } from 'adlens-shared'
import { Model } from 'mongoose'
import { JOB_MODEL, type JobDoc, type StoredJob } from '../database/job.doc'
import { StorageService } from '../storage/storage.service'
import type { CleanupResult } from './types'

// Far past the signed upload URL's lifetime, so no upload can still be on its way.
export const ABANDONED_UPLOAD_MS = 7 * 24 * 60 * 60 * 1000

// Deletes the videos of uploads nobody analyzed. Every uploaded object belongs to a job (its path is made from the user
// and job ids at creation), so the jobs find them all. The job stays pending: analyzing it later answers
// UPLOAD_INCOMPLETE, as for any upload that never arrived. Deleting a missing object succeeds, so the same job's path is
// tried again each day at no cost.
@Injectable()
export class AbandonedUploadCleanupService {
    private readonly logger = new Logger(AbandonedUploadCleanupService.name)

    constructor(
        @InjectModel(JOB_MODEL) private readonly jobs: Model<JobDoc>,
        private readonly storage: StorageService,
    ) {}

    async run(now = new Date()): Promise<CleanupResult> {
        const cutoff = new Date(now.getTime() - ABANDONED_UPLOAD_MS)
        const abandoned = await this.jobs
            .find(
                { status: JobStatus.Pending, sampleId: { $exists: false }, updatedAt: { $lt: cutoff } },
                { 'file.path': 1 },
            )
            .lean<Pick<StoredJob, '_id' | 'file'>[]>()
        const result: CleanupResult = { deleted: 0, failed: 0 }

        for (const { _id, file } of abandoned) {
            try {
                await this.storage.delete(file.path)
                result.deleted++
            } catch (err) {
                result.failed++
                this.logger.error(
                    `could not delete the upload of job ${_id.toString()}: ${err instanceof Error ? err.message : err}`,
                )
            }
        }

        this.logger.log(`deleted the uploads of ${result.deleted} jobs pending since before ${cutoff.toISOString()}`)

        return result
    }
}
