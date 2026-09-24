import { Storage } from '@google-cloud/storage'
import { analysisSettingsSchema, MAX_DURATION_S, MAX_UPLOAD_BYTES, VideoMimeType } from 'adlens-shared'
import mongoose from 'mongoose'
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'
import { z } from 'zod'
import { SAMPLE_MODEL, SampleSchema } from '../src/database/sample.doc'
import { MediaProber } from '../src/jobs/verification/media-prober'

const SAMPLES_PREFIX = 'samples'

const CONTENT_TYPES: Record<string, VideoMimeType> = {
    '.mp4': VideoMimeType.Mp4,
    '.mov': VideoMimeType.QuickTime,
    '.webm': VideoMimeType.WebM,
    '.mpeg': VideoMimeType.Mpeg,
    '.mpg': VideoMimeType.Mpeg,
    '.3gp': VideoMimeType.ThreeGpp,
    '.flv': VideoMimeType.Flv,
}

// What a maintainer writes for each sample. `video` is resolved relative to the manifest file.
const manifestSchema = z.strictObject({
    slug: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string().min(1),
    description: z.string().min(1),
    video: z.string().min(1),
    settings: analysisSettingsSchema,
    order: z.number().int().default(0),
    isPublished: z.boolean().default(true),
})

const loadEnvFile = (path: string): void => {
    try {
        process.loadEnvFile(path)
    } catch {
        // An absent env file is fine; the variable may be set in the shell.
    }
}

const requireEnv = (name: string): string => {
    const value = process.env[name]

    if (!value) {
        throw new Error(`${name} is not set`)
    }

    return value
}

// Publishes (or re-publishes) one sample ad: measures the video with ffprobe, uploads it under samples/, and upserts
// its document by slug. Jobs on a sample skip upload verification, so the checks an upload gets happen here instead.
// Usage: npm run samples:publish -- path/to/sample.json [--dry-run]
const run = async (): Promise<void> => {
    loadEnvFile('.env.local')
    loadEnvFile('.env')

    const args = process.argv.slice(2)
    const isDryRun = args.includes('--dry-run')
    const manifestPath = args.find((arg) => !arg.startsWith('--'))

    if (!manifestPath) {
        throw new Error('Usage: npm run samples:publish -- path/to/sample.json [--dry-run]')
    }

    const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
    const videoPath = resolve(dirname(manifestPath), manifest.video)
    const extension = extname(videoPath).toLowerCase()
    const contentType = CONTENT_TYPES[extension]

    if (!contentType) {
        throw new Error(`Unsupported video type ${extension}; use one of ${Object.keys(CONTENT_TYPES).join(', ')}`)
    }

    const { size } = statSync(videoPath)

    if (size > MAX_UPLOAD_BYTES) {
        throw new Error(`The video is ${size} bytes; the limit is ${MAX_UPLOAD_BYTES}`)
    }

    const probe = await new MediaProber().probe(videoPath)

    if (!Number.isFinite(probe.durationS) || probe.durationS > MAX_DURATION_S) {
        throw new Error(`The video is ${probe.durationS} s long; the limit is ${MAX_DURATION_S} s`)
    }

    const bucket = requireEnv('STORAGE_BUCKET')
    const keyFilename = process.env.STORAGE_KEY_FILE
    const path = `${SAMPLES_PREFIX}/${manifest.slug}${extension}`
    const doc = {
        slug: manifest.slug,
        title: manifest.title,
        description: manifest.description,
        file: { name: basename(videoPath), contentType, size, bucket, path },
        media: { ...probe, sizeBytes: size, contentType },
        settings: manifest.settings,
        order: manifest.order,
        isPublished: manifest.isPublished,
    }

    if (isDryRun) {
        console.log(JSON.stringify(doc, null, 4))
        console.log('Dry run: nothing was uploaded or written.')
        return
    }

    await new Storage(keyFilename ? { keyFilename } : {})
        .bucket(bucket)
        .upload(videoPath, { destination: path, contentType, resumable: false })

    await mongoose.connect(requireEnv('MONGODB_URI'))

    try {
        const model = mongoose.model(SAMPLE_MODEL, SampleSchema)

        await model.init()
        await model.findOneAndUpdate({ slug: manifest.slug }, doc, { upsert: true, runValidators: true })
        console.log(`Published sample "${manifest.slug}" (${probe.durationS.toFixed(1)} s) at gs://${bucket}/${path}`)
    } finally {
        await mongoose.disconnect()
    }
}

run().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
})
