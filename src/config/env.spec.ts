import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { validateEnvWithSecretsFile as ValidateEnvWithSecretsFile } from './env'

describe('validateEnvWithSecretsFile', () => {
    let dir: string
    let path: string
    let validateEnvWithSecretsFile: typeof ValidateEnvWithSecretsFile

    const baseEnv = { GOOGLE_CLOUD_PROJECT: 'test-project', STORAGE_BUCKET: 'test-bucket' }

    beforeAll(async () => {
        // Importing ./env builds appConfigModule, which validates the real process.env once at import time (see
        // worker.module.spec.ts); give it placeholders so this file doesn't depend on the runner's own environment.
        process.env.MONGODB_URI ??= 'mongodb://placeholder'
        process.env.GOOGLE_CLOUD_PROJECT ??= 'placeholder'
        process.env.STORAGE_BUCKET ??= 'placeholder'
        ;({ validateEnvWithSecretsFile } = await import('./env'))
    })

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'adlens-env-'))
        path = join(dir, 'api.json')
    })

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    it('works with no SECRETS_FILE set, as in tests and local dev', () => {
        const env = validateEnvWithSecretsFile({ ...baseEnv, MONGODB_URI: 'mongodb://local' })

        expect(env.MONGODB_URI).toBe('mongodb://local')
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

    it('keeps Gemini on Standard traffic and the model default thinking level unless set', () => {
        const env = validateEnvWithSecretsFile({ ...baseEnv, MONGODB_URI: 'mongodb://local' })

        expect(env.GEMINI_TRAFFIC).toBe('standard')
        expect(env.GEMINI_THINKING_LEVEL).toBeUndefined()
    })

    it('rejects a thinking level Gemini 3.8 Flash refuses', () => {
        const env = { ...baseEnv, MONGODB_URI: 'mongodb://local' }

        expect(validateEnvWithSecretsFile({ ...env, GEMINI_THINKING_LEVEL: 'LOW' }).GEMINI_THINKING_LEVEL).toBe('LOW')
        expect(() => validateEnvWithSecretsFile({ ...env, GEMINI_THINKING_LEVEL: 'MINIMAL' })).toThrow(
            'GEMINI_THINKING_LEVEL',
        )
    })
})
