import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module'
import { IpQuotaModule } from '../ip-quota/ip-quota.module'
import { LivePublisherModule } from '../live/live-publisher.module'
import { QuotaModule } from '../quota/quota.module'
import { JobLifecycle } from './job-lifecycle.service'

// Job state shared by both processes: the API moves jobs up to `queued`, the worker takes them to a final status.
@Module({
    imports: [DatabaseModule, IpQuotaModule, LivePublisherModule, QuotaModule],
    providers: [JobLifecycle],
    exports: [JobLifecycle],
})
export class JobStoreModule {}
