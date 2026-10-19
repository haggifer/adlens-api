import { JobErrorCode, MAX_DURATION_S, MAX_UPLOAD_BYTES } from 'adlens-shared'
import type { ObjectInfo, StorageService } from '../../storage/storage.service'
import { type MediaProber, type ProbeResult, UndecodableMediaError } from './media-prober'
import { VideoVerifier } from './video-verifier.service'

const PROBE: ProbeResult = { durationS: 20, width: 1080, height: 1920, hasAudio: true }

type ProbeOutcome = ProbeResult | Error

// One outcome for every probe, or one per probe in order.
const build = (info: ObjectInfo | null | Error, probe: ProbeOutcome | ProbeOutcome[] = PROBE) => {
    const outcomes = Array.isArray(probe) ? [...probe] : null
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
            const outcome = outcomes ? outcomes.shift() : probe

            if (outcome instanceof Error) {
                throw outcome
            }

            return outcome
        }),
    }

    return { verifier: new VideoVerifier(storage, prober as unknown as MediaProber), prober }
}

const verify = (info: ObjectInfo | null | Error, probe?: ProbeOutcome | ProbeOutcome[]) =>
    build(info, probe).verifier.verify('p')

const MP4: ObjectInfo = { sizeBytes: 5_000_000, contentType: 'video/mp4' }

describe('VideoVerifier', () => {
    it('measures the media from the stored object, not from what the client declared', async () => {
        expect(await verify(MP4)).toEqual({
            kind: 'verified',
            media: { ...PROBE, sizeBytes: MP4.sizeBytes, contentType: MP4.contentType },
        })
    })

    it('accepts a video exactly at the size and duration limits', async () => {
        const outcome = await verify({ ...MP4, sizeBytes: MAX_UPLOAD_BYTES }, { ...PROBE, durationS: MAX_DURATION_S })

        expect(outcome).toMatchObject({ kind: 'verified' })
    })

    it('reports an upload that has not arrived yet', async () => {
        expect(await verify(null)).toEqual({ kind: 'upload-incomplete' })
    })

    // Branch no-time-limit: lets the maintainer measure what longer videos cost.
    it('accepts a video of any length', async () => {
        expect(await verify(MP4, { ...PROBE, durationS: MAX_DURATION_S * 10 })).toMatchObject({ kind: 'verified' })
    })

    it.each([
        ['too large', { ...MP4, sizeBytes: MAX_UPLOAD_BYTES + 1 }, PROBE, JobErrorCode.VideoTooLarge],
        ['not a supported type', { ...MP4, contentType: 'video/x-matroska' }, PROBE, JobErrorCode.UnsupportedFormat],
        ['without a duration', MP4, { ...PROBE, durationS: Number.NaN }, JobErrorCode.VideoUnreadable],
        ['of zero length', MP4, { ...PROBE, durationS: 0 }, JobErrorCode.VideoUnreadable],
    ])('rejects a video that is %s', async (_case, info, probe, errorCode) => {
        expect(await verify(info, probe)).toEqual({ kind: 'rejected', errorCode })
    })

    it('treats storage and network trouble as unavailable, never as a bad video', async () => {
        expect(await verify(new Error('GCS 503'))).toEqual({ kind: 'unavailable' })
        expect(await verify(MP4, new Error('Connection reset by peer'))).toEqual({ kind: 'unavailable' })
    })

    // A read cut off mid-range looks to ffprobe like a broken file ("end of file", "moov atom not found").
    describe('a probe that finds the video undecodable', () => {
        const undecodable = () => new UndecodableMediaError('moov atom not found')

        it('is repeated, and the video is rejected only when the second probe fails the same way', async () => {
            const { verifier, prober } = build(MP4, [undecodable(), undecodable()])

            expect(await verifier.verify('p')).toEqual({ kind: 'rejected', errorCode: JobErrorCode.VideoUnreadable })
            expect(prober.probe).toHaveBeenCalledTimes(2)
        })

        it('is overruled by a second probe that reads the video', async () => {
            expect(await verify(MP4, [undecodable(), PROBE])).toMatchObject({ kind: 'verified' })
        })

        it('followed by a transient failure leaves the video alone', async () => {
            expect(await verify(MP4, [undecodable(), new Error('Connection reset by peer')])).toEqual({
                kind: 'unavailable',
            })
        })
    })
})
