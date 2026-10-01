import { analysisSettingsSchema, jobMediaSchema, uploadFileSchema } from 'adlens-shared'
import type { Types } from 'mongoose'
import { z } from 'zod'
import { zodToMongoose } from '../common/zod-to-mongoose'

export const SAMPLE_MODEL = 'Sample'

// A sample ad anyone can try, published by the maintainer, who uploads the video and measures it once, so jobs that
// analyze a sample skip upload verification.
export const sampleDocSchema = z.object({
    slug: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string().min(1),
    description: z.string().min(1),
    file: z.object({ ...uploadFileSchema.shape, bucket: z.string(), path: z.string() }),
    media: jobMediaSchema,
    // The settings the picker fills in; the user may change them before running.
    settings: analysisSettingsSchema,
    order: z.number().int().default(0),
    isPublished: z.boolean().default(true),
})

export type SampleDoc = z.infer<typeof sampleDocSchema>

export interface StoredSample extends SampleDoc {
    _id: Types.ObjectId
}

export const SampleSchema = zodToMongoose(sampleDocSchema, { timestamps: true, collection: 'samples' })
SampleSchema.index({ slug: 1 }, { unique: true })
SampleSchema.index({ isPublished: 1, order: 1 })
