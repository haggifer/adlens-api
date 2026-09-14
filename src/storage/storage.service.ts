import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Storage } from '@google-cloud/storage'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

const SIGNED_URL_TTL_MS = 15 * 60 * 1000

// Wraps the one GCS bucket both the client (via signed upload URLs) and the server use. Authenticated
// via ADC — no key in production (Cloud Run's runtime SA signs V4 URLs). Ownership is enforced by the
// API (every path is derived from the caller's userId). Locally, user ADC cannot sign V4 URLs, so an
// optional STORAGE_KEY_FILE points at a service-account key used only for this Storage client.
@Injectable()
export class StorageService {
    private readonly storage: Storage
    readonly bucketName: string

    constructor(config: ConfigService) {
        const keyFilename = config.get<string>('STORAGE_KEY_FILE')
        this.storage = new Storage(keyFilename ? { keyFilename } : {})
        this.bucketName = config.getOrThrow<string>('STORAGE_BUCKET')
    }

    private object(path: string) {
        return this.storage.bucket(this.bucketName).file(path)
    }

    async signedUploadUrl(path: string, contentType: string): Promise<string> {
        const [url] = await this.object(path).getSignedUrl({
            version: 'v4',
            action: 'write',
            expires: Date.now() + SIGNED_URL_TTL_MS,
            contentType,
        })

        return url
    }

    async downloadToTmp(path: string): Promise<string> {
        const tmpPath = join(tmpdir(), `dl-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        await this.object(path).download({ destination: tmpPath })

        return tmpPath
    }

    async delete(path: string): Promise<void> {
        await this.object(path)
            .delete()
            .catch(() => {})
    }

    async saveJson(path: string, data: unknown): Promise<void> {
        await this.object(path).save(JSON.stringify(data, null, 2), { contentType: 'application/json' })
    }
}
