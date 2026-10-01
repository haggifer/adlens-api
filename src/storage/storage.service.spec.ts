import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configStub } from '../testing/config-stub'
import { StorageService } from './storage.service'

const PATH = 'users/u1/jobs/j1/video'
const CONTENT_TYPE = 'video/mp4'
const SIZE = 1234

describe('StorageService', () => {
    let dir: string
    let storage: StorageService

    beforeAll(() => {
        // A throwaway service-account key: V4 URLs are signed locally with it, so no request leaves the test.
        const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
        const keyFile = {
            type: 'service_account',
            project_id: 'test-project',
            private_key_id: 'test',
            private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
            client_email: 'signer@test-project.iam.gserviceaccount.com',
            client_id: '1',
        }

        dir = mkdtempSync(join(tmpdir(), 'storage-spec-'))
        writeFileSync(join(dir, 'key.json'), JSON.stringify(keyFile))
        storage = new StorageService(configStub({ STORAGE_BUCKET: 'bucket', STORAGE_KEY_FILE: join(dir, 'key.json') }))
    })

    afterAll(() => rmSync(dir, { recursive: true, force: true }))

    describe('createUploadTarget', () => {
        it('signs a create-only precondition, so the URL can never overwrite an existing object', async () => {
            const target = await storage.createUploadTarget(PATH, CONTENT_TYPE, SIZE)
            const signedHeaders = new URL(target.url).searchParams.get('X-Goog-SignedHeaders')?.split(';')

            expect(signedHeaders).toEqual(expect.arrayContaining(['x-goog-if-generation-match']))
            expect(target.headers).toMatchObject({ 'x-goog-if-generation-match': '0' })
        })

        it('signs and returns the content type and the exact length', async () => {
            const target = await storage.createUploadTarget(PATH, CONTENT_TYPE, SIZE)
            const signedHeaders = new URL(target.url).searchParams.get('X-Goog-SignedHeaders')?.split(';')

            expect(signedHeaders).toEqual(expect.arrayContaining(['content-type', 'x-goog-content-length-range']))
            expect(target.headers).toEqual({
                'Content-Type': CONTENT_TYPE,
                'x-goog-content-length-range': `${SIZE},${SIZE}`,
                'x-goog-if-generation-match': '0',
            })
        })
    })

    describe('deletePrefix', () => {
        const fakeFile = (name: string) => ({ name, delete: jest.fn(async () => undefined) })

        const withBucket = (files: ReturnType<typeof fakeFile>[]) => {
            const bucket = {
                deleteFiles: jest.fn(async () => undefined),
                getFiles: jest.fn(async () => [files]),
            }
            const service = new StorageService(configStub({ STORAGE_BUCKET: 'bucket' }))

            Object.assign(service, { storage: { bucket: () => bucket } })

            return { service, bucket }
        }

        it('deletes everything under the prefix when nothing is kept', async () => {
            const { service, bucket } = withBucket([])

            await service.deletePrefix('users/u1/')

            expect(bucket.deleteFiles).toHaveBeenCalledWith({ prefix: 'users/u1/', force: true })
        })

        it('deletes every object under the prefix except the kept paths', async () => {
            const kept = fakeFile('users/u1/jobs/adopted/video')
            const own = fakeFile('users/u1/jobs/own/video')
            const { service, bucket } = withBucket([kept, own])

            await service.deletePrefix('users/u1/', new Set([kept.name]))

            expect(bucket.getFiles).toHaveBeenCalledWith({ prefix: 'users/u1/' })
            expect(bucket.deleteFiles).not.toHaveBeenCalled()
            expect(kept.delete).not.toHaveBeenCalled()
            expect(own.delete).toHaveBeenCalledWith({ ignoreNotFound: true })
        })
    })

    describe('readObject', () => {
        const withFile = (file: { getMetadata: () => Promise<unknown>; download: () => Promise<unknown> }) => {
            const service = new StorageService(configStub({ STORAGE_BUCKET: 'bucket' }))

            Object.assign(service, { storage: { bucket: () => ({ file: () => file }) } })

            return service
        }

        it('answers the stored content type and bytes', async () => {
            const content = Buffer.from('image bytes')
            const service = withFile({
                getMetadata: async () => [{ contentType: 'image/png', size: String(content.length) }],
                download: async () => [content],
            })

            expect(await service.readObject('contact/d1/0.png')).toEqual({ contentType: 'image/png', content })
        })

        it("answers null when the object doesn't exist", async () => {
            const notFound = Object.assign(new Error('No such object'), { code: 404 })
            const service = withFile({
                getMetadata: async () => {
                    throw notFound
                },
                download: async () => {
                    throw notFound
                },
            })

            expect(await service.readObject('contact/d1/0.png')).toBeNull()
        })

        it('throws when storage fails otherwise', async () => {
            const service = withFile({
                getMetadata: async () => {
                    throw Object.assign(new Error('Service Unavailable'), { code: 503 })
                },
                download: async () => [Buffer.alloc(0)],
            })

            await expect(service.readObject('contact/d1/0.png')).rejects.toThrow('Service Unavailable')
        })
    })
})
