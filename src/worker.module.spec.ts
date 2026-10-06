import type { INestApplicationContext } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import mongoose from 'mongoose'
import { AnalysisPipeline } from './analysis/pipeline/analysis-pipeline.service'
import { ChallengeVerifier } from './challenge/challenge-verifier'
import { ClientNetworkResolver } from './ip-quota/client-network.resolver'
import { IpQuotaService } from './ip-quota/ip-quota.service'
import { JobLifecycle } from './jobs/job-lifecycle.service'
import { type MemoryMongo, startMemoryMongo } from './testing/memory-mongo'

// Secrets only the API needs. The jobs mount the same bundle today, since they share the API's service account, but
// the worker must start without them so it can get an identity of its own.
const API_ONLY_SECRETS = ['BETTER_AUTH_SECRET', 'TURNSTILE_SECRET_KEY', 'RESEND_API_KEY']

describe('WorkerModule', () => {
    const originalEnv = process.env
    let mongo: MemoryMongo
    let worker: INestApplicationContext

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        process.env = {
            ...Object.fromEntries(Object.entries(originalEnv).filter(([name]) => !API_ONLY_SECRETS.includes(name))),
            NODE_ENV: 'test',
            MONGODB_URI: mongo.uri,
            GOOGLE_CLOUD_PROJECT: 'test-project',
            STORAGE_BUCKET: 'test-bucket',
            QUOTA_LIMIT: '5',
        }

        // Imported only now: the config module validates the environment as soon as it is loaded.
        const { WorkerModule } = await import('./worker.module')

        // Throws instead of exiting the test process when the graph can't be built.
        worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false, abortOnError: false })
    })

    afterAll(async () => {
        await worker?.close()
        // A graph that failed to build never closes the connection it opened, which would keep Jest running.
        await Promise.all(mongoose.connections.map((connection) => connection.close()))
        await mongo.stop()
        process.env = originalEnv
    })

    it('starts without any of the API-only secrets', () => {
        expect(API_ONLY_SECRETS.filter((name) => process.env[name] !== undefined)).toEqual([])
        expect(worker.get(AnalysisPipeline)).toBeInstanceOf(AnalysisPipeline)
    })

    it('can refund both kinds of run, which a failed analysis needs', () => {
        expect(worker.get(JobLifecycle)).toBeInstanceOf(JobLifecycle)
        expect(worker.get(IpQuotaService)).toBeInstanceOf(IpQuotaService)
    })

    it('holds none of the providers that need those secrets', () => {
        expect(() => worker.get(ClientNetworkResolver, { strict: false })).toThrow()
        expect(() => worker.get(ChallengeVerifier, { strict: false })).toThrow()
    })
})
