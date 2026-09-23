import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module'
import { QuotaService } from './quota.service'

@Module({
    imports: [DatabaseModule],
    providers: [QuotaService],
    exports: [QuotaService],
})
export class QuotaModule {}
