import { Logger, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { MongooseModule } from '@nestjs/mongoose'
import type { Connection } from 'mongoose'
import type { Env } from '../config/env'
import { CONTACT_DRAFT_MODEL, ContactDraftSchema } from './contact-draft.doc'
import { IP_QUOTA_MODEL, IpQuotaSchema } from './ip-quota.doc'
import { JOB_MODEL, JobSchema } from './job.doc'
import { RATE_LIMIT_MODEL, RateLimitSchema } from './rate-limit.doc'
import { RULESET_MODEL, RulesetSchema } from './ruleset.doc'
import { SAMPLE_MODEL, SampleSchema } from './sample.doc'
import { UPLOAD_TOMBSTONE_MODEL, UploadTombstoneSchema } from './upload-tombstone.doc'

const models = MongooseModule.forFeature([
    { name: JOB_MODEL, schema: JobSchema },
    { name: RULESET_MODEL, schema: RulesetSchema },
    { name: SAMPLE_MODEL, schema: SampleSchema },
    { name: CONTACT_DRAFT_MODEL, schema: ContactDraftSchema },
    { name: IP_QUOTA_MODEL, schema: IpQuotaSchema },
    { name: RATE_LIMIT_MODEL, schema: RateLimitSchema },
    { name: UPLOAD_TOMBSTONE_MODEL, schema: UploadTombstoneSchema },
])

const logger = new Logger('Database')

// A local run may point at the production database or the development one, so every process says which it reached.
const logDatabaseName = (connection: Connection) => {
    connection.on('connected', () => logger.log(`Connected to database ${connection.name}`))
}

// The Mongo connection and every model, registered once for both the API and the worker.
@Module({
    imports: [
        MongooseModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (config: ConfigService<Env, true>) => ({
                uri: config.get('MONGODB_URI', { infer: true }),
                onConnectionCreate: logDatabaseName,
            }),
        }),
        models,
    ],
    exports: [models],
})
export class DatabaseModule {}
