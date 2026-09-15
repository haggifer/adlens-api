import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'

import { Quota, QuotaSchema } from '../schemas/quota.schema'
import { QuotaService } from './quota.service'

@Module({
    imports: [MongooseModule.forFeature([{ name: Quota.name, schema: QuotaSchema }])],
    providers: [QuotaService],
    exports: [QuotaService],
})
export class QuotaModule {}
