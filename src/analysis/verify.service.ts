import { spawn } from 'node:child_process'

import { Injectable, UnprocessableEntityException } from '@nestjs/common'
import type { JobFile, JobMedia } from 'adlens-shared'
import ffprobeStatic from 'ffprobe-static'

import { StorageService } from '../storage/storage.service'

const MAX_DURATION_S = 60

interface ProbeResult {
    durationS: number
    width?: number
    height?: number
    hasAudio: boolean
}

const probeMedia = (input: string): Promise<ProbeResult> =>
    new Promise((resolve, reject) => {
        const proc = spawn(ffprobeStatic.path, [
            '-v',
            'error',
            '-print_format',
            'json',
            '-show_format',
            '-show_streams',
            input,
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

// Confirms the uploaded object is a real, decodable video within the duration cap. ffprobe reads it over
// a short-lived signed URL via HTTP range requests — it pulls only the header/moov, not the whole file —
// so no video bytes are copied into the instance.
@Injectable()
export class VerifyService {
    constructor(private readonly storage: StorageService) {}

    async verify(file: JobFile): Promise<JobMedia> {
        const url = await this.storage.signedDownloadUrl(file.path)

        let media: ProbeResult

        try {
            media = await probeMedia(url)
        } catch {
            throw new UnprocessableEntityException('Uploaded file is not a recognized video')
        }

        if (!Number.isFinite(media.durationS) || media.durationS <= 0) {
            throw new UnprocessableEntityException('Uploaded file is not a decodable video')
        }

        if (media.durationS > MAX_DURATION_S) {
            throw new UnprocessableEntityException(`Video exceeds the ${MAX_DURATION_S}s limit`)
        }

        return { durationS: media.durationS, width: media.width, height: media.height, hasAudio: media.hasAudio }
    }
}
