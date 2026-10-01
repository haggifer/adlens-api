import type { INestApplicationContext } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import mongoose from 'mongoose'
import { JobLifecycle } from '../jobs/job-lifecycle.service'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { AbandonedUploadCleanupService } from './abandoned-upload-cleanup.service'
import { AnonymousCleanupService } from './anonymous-cleanup.service'

// The cleanup job runs with the analysis worker's environment, which has none of these.
const API_ONLY_SECRETS = ['BETTER_AUTH_SECRET', 'TURNSTILE_SECRET_KEY', 'RESEND_API_KEY']

describe('CleanupModule', () => {
    const originalEnv = process.env
    let mongo: MemoryMongo
    let cleanup: INestApplicationContext

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        process.env = {
            ...Object.fromEntries(Object.entries(originalEnv).filter(([name]) => !API_ONLY_SECRETS.includes(name))),
            NODE_ENV: 'test',
            MONGODB_URI: mongo.uri,
            GOOGLE_CLOUD_PROJECT: 'test-project',
            STORAGE_BUCKET: 'test-bucket',
        }

        // Imported only now: the config module validates the environment as soon as it is loaded.
        const { CleanupModule } = await import('./cleanup.module')

        cleanup = await NestFactory.createApplicationContext(CleanupModule, { logger: false, abortOnError: false })
    })

    afterAll(async () => {
        await cleanup?.close()
        await Promise.all(mongoose.connections.map((connection) => connection.close()))
        await mongo.stop()
        process.env = originalEnv
    })

    it('starts without the API-only secrets and runs every cleanup against an empty database', async () => {
        const anonymous = await cleanup.get(AnonymousCleanupService).run()
        const uploads = await cleanup.get(AbandonedUploadCleanupService).run()
        const refunds = await cleanup.get(JobLifecycle).refundOwedCharges()

        expect(anonymous).toEqual({ deleted: 0, failed: 0 })
        expect(uploads).toEqual({ deleted: 0, failed: 0 })
        expect(refunds).toEqual({ refunded: 0, failed: 0 })
    })
})
