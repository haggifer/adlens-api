import { spawn } from 'node:child_process'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import ffprobeStatic from 'ffprobe-static'
import { fileTypeFromBuffer } from 'file-type'
import type { JobFile, JobMedia } from 'adlens-shared'

import { storage } from '@/infra/firebase'
import { AppError } from '@/infra/errors'

const MAX_DURATION_S = 180
const HEADER_BYTES = 64 * 1024

type StorageFile = ReturnType<ReturnType<typeof storage.bucket>['file']>

interface ProbeResult {
    durationS: number
    width?: number
    height?: number
    hasAudio: boolean
}

const readHeader = async (object: StorageFile): Promise<Buffer> => {
    const chunks: Buffer[] = []

    for await (const chunk of object.createReadStream({ start: 0, end: HEADER_BYTES - 1 })) {
        chunks.push(chunk as Buffer)
    }

    return Buffer.concat(chunks)
}

const probeMedia = (path: string): Promise<ProbeResult> =>
    new Promise((resolve, reject) => {
        const proc = spawn(ffprobeStatic.path, [
            '-v',
            'error',
            '-print_format',
            'json',
            '-show_format',
            '-show_streams',
            path,
        ])
        let out = ''
        let err = ''

        proc.stdout.on('data', (d) => {
            out += d
        })
        proc.stderr.on('data', (d) => {
            err += d
        })
        proc.on('error', reject)
        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(err || `ffprobe exited with ${code}`))
                return
            }

            try {
                const parsed = JSON.parse(out)
                const streams: Array<Record<string, unknown>> = Array.isArray(parsed.streams) ? parsed.streams : []
                const video = streams.find((s) => s.codec_type === 'video')
                const hasAudio = streams.some((s) => s.codec_type === 'audio')
                const durationRaw = parsed.format?.duration ?? video?.duration

                resolve({
                    durationS: parseFloat(String(durationRaw)),
                    width: typeof video?.width === 'number' ? video.width : undefined,
                    height: typeof video?.height === 'number' ? video.height : undefined,
                    hasAudio,
                })
            } catch (parseErr) {
                reject(parseErr instanceof Error ? parseErr : new Error('Failed to parse ffprobe output'))
            }
        })
    })

// Confirms the uploaded object is a real, decodable video within the duration cap, and returns the
// extracted media facts. Throws AppError(422) on any failure; the caller deletes the object and skips quota.
export const verifyVideo = async (file: JobFile): Promise<JobMedia> => {
    const object = storage.bucket(file.bucket).file(file.path)

    const header = await readHeader(object)
    const detected = await fileTypeFromBuffer(header)

    if (!detected || !detected.mime.startsWith('video/')) {
        throw new AppError(422, 'Uploaded file is not a recognized video', 'invalid_video')
    }

    const tmpPath = join(tmpdir(), `verify-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await object.download({ destination: tmpPath })

    try {
        const media = await probeMedia(tmpPath)

        if (!Number.isFinite(media.durationS) || media.durationS <= 0) {
            throw new AppError(422, 'Uploaded file is not a decodable video', 'invalid_video')
        }

        if (media.durationS > MAX_DURATION_S) {
            throw new AppError(422, `Video exceeds the ${MAX_DURATION_S}s limit`, 'video_too_long')
        }

        return { durationS: media.durationS, width: media.width, height: media.height, hasAudio: media.hasAudio }
    } finally {
        await unlink(tmpPath).catch(() => {})
    }
}
