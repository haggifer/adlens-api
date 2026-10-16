import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSecretsFile } from './secrets-file'

describe('readSecretsFile', () => {
    let dir: string
    let path: string

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'adlens-secrets-'))
        path = join(dir, 'api.json')
    })

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    it('gives an empty object for an unset or empty path', () => {
        expect(readSecretsFile(undefined)).toEqual({})
        expect(readSecretsFile('')).toEqual({})
    })

    it('reads a valid object of string values', () => {
        writeFileSync(path, JSON.stringify({ MONGODB_URI: 'mongodb://from-file', CONTACT_EMAIL: 'team@example.com' }))

        expect(readSecretsFile(path)).toEqual({ MONGODB_URI: 'mongodb://from-file', CONTACT_EMAIL: 'team@example.com' })
    })

    it('throws when the file is missing', () => {
        expect(() => readSecretsFile(join(dir, 'missing.json'))).toThrow(join(dir, 'missing.json'))
    })

    it('throws when the file is not valid JSON', () => {
        writeFileSync(path, '{not json')

        expect(() => readSecretsFile(path)).toThrow(/not valid JSON/)
    })

    it('throws when the top level is an array', () => {
        writeFileSync(path, JSON.stringify(['a', 'b']))

        expect(() => readSecretsFile(path)).toThrow(/must contain a JSON object/)
    })

    it('throws when the top level is null', () => {
        writeFileSync(path, 'null')

        expect(() => readSecretsFile(path)).toThrow(/must contain a JSON object/)
    })

    it('throws when a value is not a string, naming the key and never the value', () => {
        writeFileSync(path, JSON.stringify({ MONGODB_URI: 'ok', SECRET_TOKEN: 12345 }))

        expect.assertions(2)

        try {
            readSecretsFile(path)
        } catch (err) {
            expect((err as Error).message).toContain('SECRET_TOKEN')
            expect((err as Error).message).not.toContain('12345')
        }
    })
})
