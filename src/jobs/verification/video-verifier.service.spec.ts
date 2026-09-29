import { JobErrorCode, MAX_DURATION_S, MAX_UPLOAD_BYTES } from 'adlens-shared'
import type { ObjectInfo, StorageService } from '../../storage/storage.service'
import { type MediaProber, type ProbeResult, UndecodableMediaError } from './media-prober'
import { VideoVerifier } from './video-verifier.service'

const PROBE: ProbeResult = { durationS: 20, width: 1080, height: 1920, hasAudio: true }

const build = (info: ObjectInfo | null | Error, probe: ProbeResult | Error = PROBE) => {
    const storage = {
        getObjectInfo: jest.fn(async () => {
            if (info instanceof Error) {
                throw info
            }

            return info
        }),
        createReadUrl: jest.fn(async () => ({ url: 'https://signed', expiresAt: new Date() })),
    } as unknown as StorageService
    const prober = {
        probe: jest.fn(async () => {
            if (probe instanceof Error) {
                throw probe
            }

            return probe
        }),
    } as unknown as MediaProber

    return new VideoVerifier(storage, prober)
}

const MP4: ObjectInfo = { sizeBytes: 5_000_000, contentType: 'video/mp4' }

describe('VideoVerifier', () => {
    it('measures the media from the stored object, not from what the client declared', async () => {
        expect(await build(MP4).verify('p')).toEqual({
            kind: 'verified',
            media: { ...PROBE, sizeBytes: MP4.sizeBytes, contentType: MP4.contentType },
        })
    })

    it('accepts a video exactly at the size and duration limits', async () => {
        const outcome = await build(
            { ...MP4, sizeBytes: MAX_UPLOAD_BYTES },
            { ...PROBE, durationS: MAX_DURATION_S },
        ).verify('p')

        expect(outcome).toMatchObject({ kind: 'verified' })
    })

    it('reports an upload that has not arrived yet', async () => {
        expect(await build(null).verify('p')).toEqual({ kind: 'upload-incomplete' })
    })

    it.each([
        ['too large', { ...MP4, sizeBytes: MAX_UPLOAD_BYTES + 1 }, PROBE, JobErrorCode.VideoTooLarge],
        ['not a supported type', { ...MP4, contentType: 'video/x-matroska' }, PROBE, JobErrorCode.UnsupportedFormat],
        ['undecodable', MP4, new UndecodableMediaError('Invalid data found'), JobErrorCode.VideoUnreadable],
        ['too long', MP4, { ...PROBE, durationS: MAX_DURATION_S + 1 }, JobErrorCode.VideoTooLong],
        ['without a duration', MP4, { ...PROBE, durationS: Number.NaN }, JobErrorCode.VideoUnreadable],
        ['of zero length', MP4, { ...PROBE, durationS: 0 }, JobErrorCode.VideoUnreadable],
    ])('rejects a video that is %s', async (_case, info, probe, errorCode) => {
        expect(await build(info, probe).verify('p')).toEqual({ kind: 'rejected', errorCode })
    })

    it('treats storage and network trouble as unavailable, never as a bad video', async () => {
        expect(await build(new Error('GCS 503')).verify('p')).toEqual({ kind: 'unavailable' })
        expect(await build(MP4, new Error('Connection reset by peer')).verify('p')).toEqual({ kind: 'unavailable' })
    })
})
