import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module'
import { QuotaModule } from '../quota/quota.module'
import { JobLifecycle } from './job-lifecycle.service'

// Job state shared by both processes: the API moves jobs up to `queued`, the worker takes them to a final status.
@Module({
    imports: [DatabaseModule, QuotaModule],
    providers: [JobLifecycle],
    exports: [JobLifecycle],
})
export class JobStoreModule {}
