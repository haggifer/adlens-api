import { Storage } from '@google-cloud/storage'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { UploadTarget } from 'adlens-shared'
import type { Env } from '../config/env'

const SIGNED_URL_TTL_MS = 15 * 60 * 1000

export interface ObjectInfo {
    sizeBytes: number
    contentType: string
}

export interface SignedReadUrl {
    url: string
    expiresAt: Date
}

const isNotFound = (err: unknown): boolean => (err as { code?: unknown })?.code === 404

// The one GCS bucket for uploads. Authenticated via ADC; locally, user ADC can't sign V4 URLs, so an optional
// STORAGE_KEY_FILE points this client at a service-account key.
@Injectable()
export class StorageService {
    private readonly storage: Storage
    readonly bucketName: string

    constructor(config: ConfigService<Env, true>) {
        const keyFilename = config.get('STORAGE_KEY_FILE', { infer: true })

        this.storage = new Storage(keyFilename ? { keyFilename } : {})
        this.bucketName = config.get('STORAGE_BUCKET', { infer: true })
    }

    private object(path: string) {
        return this.storage.bucket(this.bucketName).file(path)
    }

    // Signs the content type and the exact length, so GCS rejects an upload that differs from what was declared.
    async createUploadTarget(path: string, contentType: string, sizeBytes: number): Promise<UploadTarget> {
        const lengthRange = `${sizeBytes},${sizeBytes}`
        const [url] = await this.object(path).getSignedUrl({
            version: 'v4',
            action: 'write',
            expires: Date.now() + SIGNED_URL_TTL_MS,
            contentType,
            extensionHeaders: { 'x-goog-content-length-range': lengthRange },
        })

        return { url, headers: { 'Content-Type': contentType, 'x-goog-content-length-range': lengthRange } }
    }

    async createReadUrl(path: string): Promise<SignedReadUrl> {
        const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_MS)
        const [url] = await this.object(path).getSignedUrl({ version: 'v4', action: 'read', expires: expiresAt })

        return { url, expiresAt }
    }

    // null when the object doesn't exist (yet).
    async getObjectInfo(path: string): Promise<ObjectInfo | null> {
        try {
            const [metadata] = await this.object(path).getMetadata()

            return { sizeBytes: Number(metadata.size), contentType: metadata.contentType ?? '' }
        } catch (err) {
            if (isNotFound(err)) {
                return null
            }

            throw err
        }
    }

    async delete(path: string): Promise<void> {
        await this.object(path).delete({ ignoreNotFound: true })
    }

    async deletePrefix(prefix: string): Promise<void> {
        await this.storage.bucket(this.bucketName).deleteFiles({ prefix, force: true })
    }
}
