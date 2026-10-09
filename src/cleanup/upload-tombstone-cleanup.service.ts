import { Injectable, Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { describeError } from '../common/error-message'
import { JOB_MODEL, type JobDoc } from '../database/job.doc'
import { UPLOAD_TOMBSTONE_MODEL, type UploadTombstoneDoc } from '../database/upload-tombstone.doc'
import { StorageService } from '../storage/storage.service'
import type { CleanupResult } from './types'

// Only user uploads ever get a tombstone; a shared sample or demo video must never be deleted, whatever is recorded.
const USER_UPLOAD_PREFIX = 'users/'

// Deletes the upload paths of jobs deleted while their upload URL still worked, once that URL has expired: whatever a
// late PUT stored there backs no job. A path some job still references (its deletion failed after the tombstone was
// recorded) is kept. A tombstone is removed only after its path is handled, so a failure is retried the next day.
@Injectable()
export class UploadTombstoneCleanupService {
    private readonly logger = new Logger(UploadTombstoneCleanupService.name)

    constructor(
        @InjectModel(UPLOAD_TOMBSTONE_MODEL) private readonly tombstones: Model<UploadTombstoneDoc>,
        @InjectModel(JOB_MODEL) private readonly jobs: Model<JobDoc>,
        private readonly storage: StorageService,
    ) {}

    async run(now = new Date()): Promise<CleanupResult> {
        const due = await this.tombstones.find({ deleteAfter: { $lte: now } }).lean()
        const result: CleanupResult = { deleted: 0, failed: 0 }

        for (const { _id, path } of due) {
            try {
                const isDeleted = await this.deleteOrphan(path)

                await this.tombstones.deleteOne({ _id })

                if (isDeleted) {
                    result.deleted++
                }
            } catch (err) {
                result.failed++
                this.logger.error(`could not handle upload tombstone ${_id.toString()}: ${describeError(err)}`)
            }
        }

        this.logger.log(`deleted ${result.deleted} uploads made after their job was deleted, ${result.failed} failed`)

        return result
    }

    // false when the path isn't an orphan to delete.
    private async deleteOrphan(path: string): Promise<boolean> {
        const isReferenced = await this.jobs.exists({ 'file.path': path })

        if (isReferenced || !path.startsWith(USER_UPLOAD_PREFIX)) {
            return false
        }

        await this.storage.delete(path)

        return true
    }
}
