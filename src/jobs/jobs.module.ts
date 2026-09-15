import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'

import { AnalysisModule } from '../analysis/analysis.module'
import { AuthModule } from '../auth/auth.module'
import { QuotaModule } from '../quota/quota.module'
import { Job, JobSchema } from '../schemas/job.schema'
import { StorageModule } from '../storage/storage.module'
import { JobsController } from './jobs.controller'
import { JobsService } from './jobs.service'

@Module({
    imports: [
        MongooseModule.forFeature([{ name: Job.name, schema: JobSchema }]),
        AuthModule,
        StorageModule,
        QuotaModule,
        AnalysisModule,
    ],
    controllers: [JobsController],
    providers: [JobsService],
})
export class JobsModule {}
