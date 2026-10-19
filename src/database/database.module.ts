import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { MongooseModule } from '@nestjs/mongoose'
import type { Env } from '../config/env'
import { CONTACT_DRAFT_MODEL, ContactDraftSchema } from './contact-draft.doc'
import { IP_QUOTA_MODEL, IpQuotaSchema } from './ip-quota.doc'
import { JOB_MODEL, JobSchema } from './job.doc'
import { RATE_LIMIT_MODEL, RateLimitSchema } from './rate-limit.doc'
import { RULESET_MODEL, RulesetSchema } from './ruleset.doc'
import { SAMPLE_MODEL, SampleSchema } from './sample.doc'
import { UPLOAD_TOMBSTONE_MODEL, UploadTombstoneSchema } from './upload-tombstone.doc'

export const MODEL_DEFINITIONS = [
    { name: JOB_MODEL, schema: JobSchema },
    { name: RULESET_MODEL, schema: RulesetSchema },
    { name: SAMPLE_MODEL, schema: SampleSchema },
    { name: CONTACT_DRAFT_MODEL, schema: ContactDraftSchema },
    { name: IP_QUOTA_MODEL, schema: IpQuotaSchema },
    { name: RATE_LIMIT_MODEL, schema: RateLimitSchema },
    { name: UPLOAD_TOMBSTONE_MODEL, schema: UploadTombstoneSchema },
]

const models = MongooseModule.forFeature(MODEL_DEFINITIONS)

// The Mongo connection and every model, registered once for every process. No process changes the database's
// structure on start: the database job (db.ts) creates the indexes and validators after each deploy, so a cold start
// sends no createIndex calls, no instance is the one that builds a new index on a large collection, and the job's dry
// run changes nothing.
@Module({
    imports: [
        MongooseModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (config: ConfigService<Env, true>) => ({
                uri: config.get('MONGODB_URI', { infer: true }),
                autoIndex: false,
                autoCreate: false,
            }),
        }),
        models,
    ],
    exports: [models],
})
export class DatabaseModule {}
