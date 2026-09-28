import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module'
import { IpQuotaService } from './ip-quota.service'

// Needs no secret, so the worker can import it to refund failed runs.
@Module({
    imports: [DatabaseModule],
    providers: [IpQuotaService],
    exports: [IpQuotaService],
})
export class IpQuotaModule {}
