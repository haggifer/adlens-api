import { Module } from '@nestjs/common'
import { QuotaModule } from '../quota/quota.module'
import { MeController } from './me.controller'
import { VisitorQuotaController } from './visitor-quota.controller'

@Module({
    imports: [QuotaModule],
    controllers: [MeController, VisitorQuotaController],
})
export class MeModule {}
