import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { LOCAL_FILE_PROTOCOLS, MediaProber, parseProbeOutput, UndecodableMediaError } from './media-prober'

jest.mock('node:child_process', () => ({ spawn: jest.fn() }))

interface StreamFields {
    width?: number
    height?: number
    tags?: Record<string, string>
    side_data_list?: Record<string, unknown>[]
}

const ffprobeJson = (video: StreamFields) =>
    JSON.stringify({
        streams: [
            { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, ...video },
            { index: 1, codec_type: 'audio', codec_name: 'aac' },
        ],
        format: { duration: '12.480000' },
    })

const SIGNED_URL =
    'https://storage.googleapis.com/test-bucket/users/u1/jobs/j1/video?X-Goog-Algorithm=GOOG4-RSA-SHA256' +
    '&X-Goog-Credential=api%40project.iam.gserviceaccount.com&X-Goog-Signature=0123abcd'

const flagValues = (args: readonly string[], flag: string): string[] => {
    const index = args.indexOf(flag)

    return index === -1 ? [] : args[index + 1].split(',')
}

const ffprobeExiting = (code: number, stderr: string) => {
    jest.mocked(spawn).mockImplementationOnce(() => {
        const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() })

        setImmediate(() => {
            proc.stderr.emit('data', stderr)
            proc.emit('close', code)
        })

        return proc as never
    })
}

const displayMatrix = (rotation: number) => ({
    side_data_type: 'Display Matrix',
    displaymatrix: '\n00000000:            0       65536           0\n',
    rotation,
})

describe('parseProbeOutput', () => {
    it('reads the duration, the stored dimensions and the audio stream', () => {
        expect(parseProbeOutput(ffprobeJson({}))).toEqual({
            durationS: 12.48,
            width: 1920,
            height: 1080,
            hasAudio: true,
        })
    })

    it.each([-90, 90, 270, -270])('swaps width and height for a display matrix rotated %i°', (rotation) => {
        const result = parseProbeOutput(ffprobeJson({ side_data_list: [displayMatrix(rotation)] }))

        expect(result).toMatchObject({ width: 1080, height: 1920 })
    })

    it.each([0, 180, -180])('keeps width and height for a display matrix rotated %i°', (rotation) => {
        const result = parseProbeOutput(ffprobeJson({ side_data_list: [displayMatrix(rotation)] }))

        expect(result).toMatchObject({ width: 1920, height: 1080 })
    })

    it.each(['90', '270'])('swaps width and height for a legacy rotate tag of %s', (rotate) => {
        const result = parseProbeOutput(ffprobeJson({ tags: { rotate } }))

        expect(result).toMatchObject({ width: 1080, height: 1920 })
    })

    it('rotates once when both the display matrix and the legacy tag are present', () => {
        const result = parseProbeOutput(ffprobeJson({ tags: { rotate: '90' }, side_data_list: [displayMatrix(-90)] }))

        expect(result).toMatchObject({ width: 1080, height: 1920 })
    })

    it('ignores side data that is not a display matrix', () => {
        const result = parseProbeOutput(ffprobeJson({ side_data_list: [{ side_data_type: 'Stereo 3D' }] }))

        expect(result).toMatchObject({ width: 1920, height: 1080 })
    })
})

describe('MediaProber', () => {
    const prober = new MediaProber()

    const probeError = (input: string): Promise<Error> =>
        prober.probe(input).then(
            () => {
                throw new Error('The probe was expected to fail')
            },
            (err: unknown) => err as Error,
        )

    afterEach(() => {
        jest.mocked(spawn).mockReset()
    })

    it('reads only HTTPS and no playlist formats, without the API’s environment and its secrets', async () => {
        ffprobeExiting(1, 'Invalid data found when processing input')

        await expect(prober.probe(SIGNED_URL)).rejects.toThrow()

        const [, args, options] = jest.mocked(spawn).mock.calls[0]
        const protocols = flagValues(args, '-protocol_whitelist')
        const formats = flagValues(args, '-format_whitelist')

        expect(protocols).toContain('https')
        expect(protocols).not.toContain('file')
        expect(protocols).not.toContain('http')
        expect(formats).toContain('mp4')
        expect(formats).not.toContain('hls')
        expect(formats).not.toContain('dash')
        expect(args.at(-1)).toBe(SIGNED_URL)
        expect(options?.env).toEqual({ PATH: process.env.PATH })
    })

    it('opens a local file only when the caller asks for it', async () => {
        ffprobeExiting(1, 'Invalid data found when processing input')

        await expect(prober.probe('C:/videos/demo.mp4', LOCAL_FILE_PROTOCOLS)).rejects.toThrow()

        const [, args] = jest.mocked(spawn).mock.calls[0]

        expect(args.join(' ')).toContain('-protocol_whitelist file')
    })

    it('keeps the signed query of the URL it read out of the error, which gets logged', async () => {
        ffprobeExiting(
            1,
            `${SIGNED_URL}: Server returned 403 Forbidden (access denied)
`,
        )

        const error = await probeError(SIGNED_URL)

        expect(error.message).toBe(
            'https://storage.googleapis.com/test-bucket/users/u1/jobs/j1/video: Server returned 403 Forbidden (access denied)',
        )
        expect(error).not.toBeInstanceOf(UndecodableMediaError)
    })

    it('takes a file in a format off the list, such as a playlist uploaded as MP4, as undecodable', async () => {
        ffprobeExiting(
            1,
            `[hls @ 0x1] Format not on whitelist 'mov,mp4'
${SIGNED_URL}: Invalid argument
`,
        )

        const error = await probeError(SIGNED_URL)

        expect(error).toBeInstanceOf(UndecodableMediaError)
        expect(error.message).not.toContain('X-Goog-Signature')
    })
})
