import { JobsClient } from '@google-cloud/run'
import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'

import { Job, JobSchema } from '../schemas/job.schema'
import { StorageModule } from '../storage/storage.module'
import { AnalysisLauncher, RUN_JOBS_CLIENT } from './analysis-launcher.service'
import { AnalysisRunner } from './analysis-runner.service'
import { VerifyService } from './verify.service'

@Module({
    imports: [MongooseModule.forFeature([{ name: Job.name, schema: JobSchema }]), StorageModule],
    providers: [
        VerifyService,
        AnalysisRunner,
        AnalysisLauncher,
        { provide: RUN_JOBS_CLIENT, useFactory: () => new JobsClient() },
    ],
    exports: [VerifyService, AnalysisLauncher],
})
export class AnalysisModule {}
