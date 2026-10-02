import { Injectable, Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { userPrefix } from '../common/paths'
import { JOB_MODEL, type JobDoc, type StoredJob } from '../database/job.doc'
import { QuotaService } from '../quota/quota.service'
import { StorageService } from '../storage/storage.service'

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Everything AdLens stores for a user outside Better Auth's own collections: jobs and every uploaded object. The quota
// runs live on the user document, which Better Auth deletes itself.
@Injectable()
export class AccountDataService {
    private readonly logger = new Logger(AccountDataService.name)

    constructor(
        @InjectModel(JOB_MODEL) private readonly jobs: Model<JobDoc>,
        private readonly storage: StorageService,
        private readonly quota: QuotaService,
    ) {}

    // An anonymous user signed up or in: their jobs and runs become the account's. The videos stay where they were
    // uploaded, under the anonymous user's prefix; jobs find them by `file.path`.
    async adopt(anonymousUserId: string, userId: string): Promise<void> {
        await this.quota.transfer(anonymousUserId, userId)
        await this.jobs.updateMany({ userId: anonymousUserId }, { $set: { userId } })
        this.logger.log(`moved the data of anonymous user ${anonymousUserId} to user ${userId}`)
    }

    async purge(userId: string): Promise<void> {
        const ownPrefix = userPrefix(userId)
        const adoptedUploads = await this.findAdoptedUploads(userId, ownPrefix)
        const uploadsAdoptedByOthers = await this.findUploadsAdoptedByOthers(userId)

        await Promise.all(adoptedUploads.map((path) => this.storage.delete(path)))
        await this.storage.deletePrefix(ownPrefix, uploadsAdoptedByOthers)
        await this.jobs.deleteMany({ userId })
        this.logger.log(`purged the data of deleted user ${userId}`)
    }

    // The uploads of jobs this user adopted, still under the prefix of the anonymous user they were uploaded by.
    private async findAdoptedUploads(userId: string, ownPrefix: string): Promise<string[]> {
        const jobs = await this.jobs
            .find({ userId }, { sampleId: 1, file: 1 })
            .lean<Pick<StoredJob, 'sampleId' | 'file'>[]>()

        return jobs.filter((job) => !job.sampleId && !job.file.path.startsWith(ownPrefix)).map((job) => job.file.path)
    }

    // An anonymous user can outlive its link (Better Auth only logs a failed delete of it), and its prefix still holds
    // the videos the account adopted.
    private async findUploadsAdoptedByOthers(userId: string): Promise<Set<string>> {
        const jobs = await this.jobs
            .find(
                { userId: { $ne: userId }, 'file.path': { $regex: `^${escapeRegExp(userPrefix(userId))}` } },
                { file: 1 },
            )
            .lean<Pick<StoredJob, 'file'>[]>()

        return new Set(jobs.map((job) => job.file.path))
    }
}
