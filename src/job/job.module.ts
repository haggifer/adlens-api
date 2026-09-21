import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { MongooseModule } from '@nestjs/mongoose'

import { AnalysisRunner } from '../analysis/analysis-runner.service'
import { JOB_MODEL, JobSchema } from '../schemas/job.schema'
import { StorageModule } from '../storage/storage.module'

// Minimal module for the on-demand analysis Cloud Run Job process (src/job.ts): just the pieces
// AnalysisRunner needs — config, the Mongo connection, the Job model, and storage.
@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
        MongooseModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({ uri: config.getOrThrow<string>('MONGODB_URI') }),
        }),
        MongooseModule.forFeature([{ name: JOB_MODEL, schema: JobSchema }]),
        StorageModule,
    ],
    providers: [AnalysisRunner],
})
export class JobModule {}
