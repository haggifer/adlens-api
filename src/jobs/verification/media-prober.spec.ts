import { parseProbeOutput } from './media-prober'

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
