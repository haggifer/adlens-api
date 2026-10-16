import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { validateEnvWithSecretsFile as ValidateEnvWithSecretsFile } from './env'

describe('validateEnvWithSecretsFile', () => {
    let dir: string
    let path: string
    let validateEnvWithSecretsFile: typeof ValidateEnvWithSecretsFile

    const baseEnv = { GOOGLE_CLOUD_PROJECT: 'test-project', STORAGE_BUCKET: 'test-bucket', QUOTA_LIMIT: '5' }

    beforeAll(async () => {
        // Importing ./env builds appConfigModule, which validates the real process.env once at import time (see
        // worker.module.spec.ts); give it placeholders so this file doesn't depend on the runner's own environment.
        process.env.MONGODB_URI ??= 'mongodb://placeholder'
        process.env.GOOGLE_CLOUD_PROJECT ??= 'placeholder'
        process.env.STORAGE_BUCKET ??= 'placeholder'
        process.env.QUOTA_LIMIT ??= '5'
        ;({ validateEnvWithSecretsFile } = await import('./env'))
    })

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'adlens-env-'))
        path = join(dir, 'api.json')
    })

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    it('fills a missing key from the secrets file', () => {
        writeFileSync(path, JSON.stringify({ MONGODB_URI: 'mongodb://from-file' }))

        const env = validateEnvWithSecretsFile({ ...baseEnv, SECRETS_FILE: path })

        expect(env.MONGODB_URI).toBe('mongodb://from-file')
    })

    it('lets a value already in the environment win over the file', () => {
        writeFileSync(path, JSON.stringify({ MONGODB_URI: 'mongodb://from-file' }))

        const env = validateEnvWithSecretsFile({ ...baseEnv, SECRETS_FILE: path, MONGODB_URI: 'mongodb://from-env' })

        expect(env.MONGODB_URI).toBe('mongodb://from-env')
    })

    it('still fails validation when a required key is in neither the environment nor the file', () => {
        writeFileSync(path, JSON.stringify({ BETTER_AUTH_SECRET: 'shh' }))

        expect(() => validateEnvWithSecretsFile({ ...baseEnv, SECRETS_FILE: path })).toThrow('MONGODB_URI')
    })
})
