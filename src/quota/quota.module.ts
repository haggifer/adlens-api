import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'

import { QUOTA_MODEL, QuotaSchema } from '../schemas/quota.schema'
import { QuotaService } from './quota.service'

@Module({
    imports: [MongooseModule.forFeature([{ name: QUOTA_MODEL, schema: QuotaSchema }])],
    providers: [QuotaService],
    exports: [QuotaService],
})
export class QuotaModule {}
