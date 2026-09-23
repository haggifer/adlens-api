import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { MongooseModule } from '@nestjs/mongoose'
import type { Env } from '../config/env'
import { JOB_MODEL, JobSchema } from './job.doc'
import { QUOTA_MODEL, QuotaSchema } from './quota.doc'
import { RULESET_MODEL, RulesetSchema } from './ruleset.doc'

const models = MongooseModule.forFeature([
    { name: JOB_MODEL, schema: JobSchema },
    { name: QUOTA_MODEL, schema: QuotaSchema },
    { name: RULESET_MODEL, schema: RulesetSchema },
])

// The Mongo connection and every model, registered once for both the API and the worker.
@Module({
    imports: [
        MongooseModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (config: ConfigService<Env, true>) => ({ uri: config.get('MONGODB_URI', { infer: true }) }),
        }),
        models,
    ],
    exports: [models],
})
export class DatabaseModule {}
