import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { MongooseModule } from '@nestjs/mongoose'

import { AnalysisRunner } from '../analysis/analysis-runner.service'
import { Job, JobSchema } from '../schemas/job.schema'
import { StorageModule } from '../storage/storage.module'
import { AnalyzeProcessor } from './analyze.processor'

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
        MongooseModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({ uri: config.getOrThrow<string>('MONGODB_URI') }),
        }),
        MongooseModule.forFeature([{ name: Job.name, schema: JobSchema }]),
        StorageModule,
    ],
    providers: [AnalysisRunner, AnalyzeProcessor],
})
export class WorkerModule {}
