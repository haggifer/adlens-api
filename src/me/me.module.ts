import { Module } from '@nestjs/common'
import { QuotaModule } from '../quota/quota.module'
import { MeController } from './me.controller'

@Module({
    imports: [QuotaModule],
    controllers: [MeController],
})
export class MeModule {}
