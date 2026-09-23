import { Injectable, Logger } from '@nestjs/common'
import { JobErrorCode, type JobMedia, MAX_DURATION_S, MAX_UPLOAD_BYTES, videoMimeTypeSchema } from 'adlens-shared'
import { StorageService } from '../../storage/storage.service'
import { MediaProber, type ProbeResult, UndecodableMediaError } from './media-prober'

export type VerificationOutcome =
    | { kind: 'verified'; media: JobMedia }
    | { kind: 'rejected'; errorCode: JobErrorCode }
    | { kind: 'upload-incomplete' }
    | { kind: 'unavailable' }

const reject = (errorCode: JobErrorCode): VerificationOutcome => ({ kind: 'rejected', errorCode })

// Decides whether an uploaded object is an acceptable video, measuring its facts from the object itself rather than
// trusting the client. Only a definite problem with the file rejects it; storage or network trouble is `unavailable`,
// so the user's upload is never deleted because of a transient error.
@Injectable()
export class VideoVerifier {
    private readonly logger = new Logger(VideoVerifier.name)

    constructor(
        private readonly storage: StorageService,
        private readonly prober: MediaProber,
    ) {}

    async verify(path: string): Promise<VerificationOutcome> {
        try {
            return await this.inspect(path)
        } catch (err) {
            this.logger.warn(`verification of ${path} could not finish: ${err instanceof Error ? err.message : err}`)

            return { kind: 'unavailable' }
        }
    }

    private async inspect(path: string): Promise<VerificationOutcome> {
        const info = await this.storage.getObjectInfo(path)

        if (!info) {
            return { kind: 'upload-incomplete' }
        }

        if (info.sizeBytes > MAX_UPLOAD_BYTES) {
            return reject(JobErrorCode.VideoTooLarge)
        }

        if (!videoMimeTypeSchema.safeParse(info.contentType).success) {
            return reject(JobErrorCode.UnsupportedFormat)
        }

        const { url } = await this.storage.createReadUrl(path)
        let probe: ProbeResult

        try {
            probe = await this.prober.probe(url)
        } catch (err) {
            if (err instanceof UndecodableMediaError) {
                return reject(JobErrorCode.VideoUnreadable)
            }

            throw err
        }

        if (!Number.isFinite(probe.durationS) || probe.durationS <= 0) {
            return reject(JobErrorCode.VideoUnreadable)
        }

        if (probe.durationS > MAX_DURATION_S) {
            return reject(JobErrorCode.VideoTooLong)
        }

        return {
            kind: 'verified',
            media: {
                durationS: probe.durationS,
                width: probe.width,
                height: probe.height,
                hasAudio: probe.hasAudio,
                sizeBytes: info.sizeBytes,
                contentType: info.contentType,
            },
        }
    }
}
