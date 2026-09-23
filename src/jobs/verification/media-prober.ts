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
}

const toResult = (stdout: string): ProbeResult => {
    const parsed = JSON.parse(stdout) as { streams?: ProbeStream[]; format?: { duration?: unknown } }
    const streams = parsed.streams ?? []
    const video = streams.find((stream) => stream.codec_type === 'video')

    if (!video) {
        throw new UndecodableMediaError('No video stream')
    }

    return {
        durationS: Number.parseFloat(String(parsed.format?.duration ?? video.duration)),
        width: typeof video.width === 'number' ? video.width : undefined,
        height: typeof video.height === 'number' ? video.height : undefined,
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
                    resolve(toResult(stdout))
                } catch (err) {
                    reject(err instanceof UndecodableMediaError ? err : new UndecodableMediaError(String(err)))
                }
            })
        })
    }
}
