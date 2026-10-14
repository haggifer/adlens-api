import { Injectable } from '@nestjs/common'
import ffprobeStatic from 'ffprobe-static'
import { spawn } from 'node:child_process'

export interface ProbeResult {
    durationS: number
    width?: number
    height?: number
    hasAudio: boolean
}

interface ProbeStream {
    codec_type?: string
    width?: unknown
    height?: unknown
    duration?: unknown
    tags?: { rotate?: unknown }
    side_data_list?: { side_data_type?: unknown; rotation?: unknown }[]
}

const PROBE_TIMEOUT_MS = 30 * 1000

// ffprobe detects the format from the content, whatever the declared type: a playlist or a DASH manifest uploaded as
// MP4 would make it fetch the URLs inside (from our network) and measure another file than the one Gemini reads. Only
// the containers of the accepted video types are read.
const FORMAT_WHITELIST = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm'
// A user's upload is always read through a signed HTTPS URL; ffprobe may open nothing else (a local file, another
// protocol a format points at), whatever the file says.
const REMOTE_PROTOCOLS = 'https,tls,tcp'

// For the maintainer's publishing scripts, which measure a video on disk before uploading it.
export const LOCAL_FILE_PROTOCOLS = 'file'

// ffprobe's wording when it reached the input but couldn't read it as media, or read a format off the list.
const UNDECODABLE_PATTERN =
    /invalid data found|moov atom not found|could not find codec|end of file|format not on whitelist/i

// ffprobe starts its message with the input, and a signed read URL in a log is a working credential for 15 minutes.
// The query holds the signature; the rest names the object.
const SIGNED_QUERY_PATTERN = /(https?:\/\/[^\s?]+)\?\S*?(?=:\s|\s|$)/g

const redactSignedUrls = (text: string) => text.replace(SIGNED_QUERY_PATTERN, '$1')

// Phones store a portrait video as landscape frames plus a rotation to apply on playback. Newer ffprobe reports it as
// the display matrix's rotation; older files and builds as the legacy `rotate` tag.
const getRotation = (stream: ProbeStream): number => {
    const matrix = stream.side_data_list?.find((data) => data.side_data_type === 'Display Matrix')
    const rotation = Number(matrix?.rotation ?? stream.tags?.rotate ?? 0)

    return Number.isFinite(rotation) ? rotation : 0
}

const isQuarterTurn = (rotation: number) => Math.abs(Math.round(rotation / 90)) % 2 === 1

// The input was reachable but isn't a readable video. Anything else ffprobe throws is treated as transient.
export class UndecodableMediaError extends Error {}

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
    probe(input: string, protocols = REMOTE_PROTOCOLS): Promise<ProbeResult> {
        return new Promise((resolve, reject) => {
            const proc = spawn(
                ffprobeStatic.path,
                [
                    '-v',
                    'error',
                    '-protocol_whitelist',
                    protocols,
                    '-format_whitelist',
                    FORMAT_WHITELIST,
                    '-print_format',
                    'json',
                    '-show_format',
                    '-show_streams',
                    input,
                ],
                // Not the API's environment, which holds its secrets: ffprobe runs on user content. On Windows, Node
                // adds the system variables a process needs itself.
                { timeout: PROBE_TIMEOUT_MS, env: { PATH: process.env.PATH } },
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
                    const message = redactSignedUrls(stderr.trim()) || `ffprobe exited with ${code}`

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
