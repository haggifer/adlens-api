import { Injectable } from '@nestjs/common'
import ffprobeStatic from 'ffprobe-static'
import { spawn } from 'node:child_process'

const PROBE_TIMEOUT_MS = 30 * 1000

// ffprobe's wording when it reached the input but couldn't read it as media.
const UNDECODABLE_PATTERN = /invalid data found|moov atom not found|could not find codec|end of file/i

export interface ProbeResult {
    durationS: number
    width?: number
    height?: number
    hasAudio: boolean
}

// The input was reachable but isn't a readable video. Anything else ffprobe throws is treated as transient.
export class UndecodableMediaError extends Error {}

interface ProbeStream {
    codec_type?: string
    width?: unknown
    height?: unknown
    duration?: unknown
    tags?: { rotate?: unknown }
    side_data_list?: { side_data_type?: unknown; rotation?: unknown }[]
}

// Phones store a portrait video as landscape frames plus a rotation to apply on playback. Newer ffprobe reports it as
// the display matrix's rotation; older files and builds as the legacy `rotate` tag.
const getRotation = (stream: ProbeStream): number => {
    const matrix = stream.side_data_list?.find((data) => data.side_data_type === 'Display Matrix')
    const rotation = Number(matrix?.rotation ?? stream.tags?.rotate ?? 0)

    return Number.isFinite(rotation) ? rotation : 0
}

const isQuarterTurn = (rotation: number) => Math.abs(Math.round(rotation / 90)) % 2 === 1

export const parseProbeOutput = (stdout: string): ProbeResult => {
    const parsed = JSON.parse(stdout) as { streams?: ProbeStream[]; format?: { duration?: unknown } }
    const streams = parsed.streams ?? []
    const video = streams.find((stream) => stream.codec_type === 'video')

    if (!video) {
        throw new UndecodableMediaError('No video stream')
    }

    const storedWidth = typeof video.width === 'number' ? video.width : undefined
    const storedHeight = typeof video.height === 'number' ? video.height : undefined
    const isSideways = isQuarterTurn(getRotation(video))

    return {
        durationS: Number.parseFloat(String(parsed.format?.duration ?? video.duration)),
        width: isSideways ? storedHeight : storedWidth,
        height: isSideways ? storedWidth : storedHeight,
        hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
    }
}

// Reads container and stream metadata with ffprobe. Given a signed URL, ffprobe fetches only the byte ranges it needs
// (the header / moov atom), so the video is never copied into the instance.
@Injectable()
export class MediaProber {
    probe(input: string): Promise<ProbeResult> {
        return new Promise((resolve, reject) => {
            const proc = spawn(
                ffprobeStatic.path,
                ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input],
                { timeout: PROBE_TIMEOUT_MS },
            )
            let stdout = ''
            let stderr = ''

            proc.stdout.on('data', (chunk) => {
                stdout += chunk
            })
            proc.stderr.on('data', (chunk) => {
                stderr += chunk
            })
            proc.on('error', reject)
            proc.on('close', (code) => {
                if (code !== 0) {
                    const message = stderr.trim() || `ffprobe exited with ${code}`

                    reject(UNDECODABLE_PATTERN.test(stderr) ? new UndecodableMediaError(message) : new Error(message))
                    return
                }

                try {
                    resolve(parseProbeOutput(stdout))
                } catch (err) {
                    reject(err instanceof UndecodableMediaError ? err : new UndecodableMediaError(String(err)))
                }
            })
        })
    }
}
