import { type INestApplicationContext, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Env } from './env'

// Proves appConfigModule's `validate` is validateEnvWithSecretsFile, not the plain validateEnv: MONGODB_URI is
// required and deleted from the environment below, so this can only build if SECRETS_FILE's value filled it in.
describe('appConfigModule', () => {
    const originalEnv = process.env
    let dir: string
    let context: INestApplicationContext

    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'adlens-app-config-'))
        const path = join(dir, 'api.json')
        writeFileSync(path, JSON.stringify({ MONGODB_URI: 'mongodb://from-bundle' }))

        process.env = {
            ...Object.fromEntries(Object.entries(originalEnv).filter(([name]) => name !== 'MONGODB_URI')),
            NODE_ENV: 'test',
            GOOGLE_CLOUD_PROJECT: 'test-project',
            STORAGE_BUCKET: 'test-bucket',
            SECRETS_FILE: path,
        }

        // Imported only now: appConfigModule validates the environment as soon as it is loaded (see worker.module.spec.ts).
        const { appConfigModule } = await import('./env')

        @Module({ imports: [appConfigModule] })
        class TestRootModule {}

        context = await NestFactory.createApplicationContext(TestRootModule, { logger: false, abortOnError: false })
    })

    afterAll(async () => {
        await context?.close()
        rmSync(dir, { recursive: true, force: true })
        process.env = originalEnv
    })

    it('fills a required key from SECRETS_FILE, which only happens through validateEnvWithSecretsFile', () => {
        const config = context.get(ConfigService<Env, true>)

        expect(config.get('MONGODB_URI', { infer: true })).toBe('mongodb://from-bundle')
    })
})
