import { Injectable, Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { userPrefix } from '../common/paths'
import { JOB_MODEL, type JobDoc } from '../database/job.doc'
import { QUOTA_MODEL, type QuotaDoc } from '../database/quota.doc'
import { StorageService } from '../storage/storage.service'

// Everything AdLens stores for a user outside Better Auth's own collections: jobs, quota and every uploaded object.
@Injectable()
export class AccountDataService {
    private readonly logger = new Logger(AccountDataService.name)

    constructor(
        @InjectModel(JOB_MODEL) private readonly jobs: Model<JobDoc>,
        @InjectModel(QUOTA_MODEL) private readonly quotas: Model<QuotaDoc>,
        private readonly storage: StorageService,
    ) {}

    async purge(userId: string): Promise<void> {
        await this.storage.deletePrefix(userPrefix(userId))
        await Promise.all([this.jobs.deleteMany({ userId }), this.quotas.deleteMany({ userId })])
        this.logger.log(`purged the data of deleted user ${userId}`)
    }
}
