import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { MongooseModule } from '@nestjs/mongoose'
import type { Env } from '../config/env'
import { CONTACT_MESSAGE_MODEL, ContactMessageSchema } from './contact-message.doc'
import { IP_QUOTA_MODEL, IpQuotaSchema } from './ip-quota.doc'
import { JOB_MODEL, JobSchema } from './job.doc'
import { RULESET_MODEL, RulesetSchema } from './ruleset.doc'
import { SAMPLE_MODEL, SampleSchema } from './sample.doc'

const models = MongooseModule.forFeature([
    { name: JOB_MODEL, schema: JobSchema },
    { name: RULESET_MODEL, schema: RulesetSchema },
    { name: SAMPLE_MODEL, schema: SampleSchema },
    { name: CONTACT_MESSAGE_MODEL, schema: ContactMessageSchema },
    { name: IP_QUOTA_MODEL, schema: IpQuotaSchema },
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
