import { z } from 'zod'
import { zodToMongoose } from '../common/zod-to-mongoose'

export const UPLOAD_TOMBSTONE_MODEL = 'UploadTombstone'

// The upload path of a job deleted while the upload URL signed at its creation could still be used: that URL is
// create-only, and with the object gone a PUT to it would store a video no job references. The daily cleanup deletes the
// path once the URL has expired (UploadTombstoneCleanupService).
const uploadTombstoneDocSchema = z.object({
    path: z.string(),
    deleteAfter: z.date(),
})

export type UploadTombstoneDoc = z.infer<typeof uploadTombstoneDocSchema>

export const UploadTombstoneSchema = zodToMongoose(uploadTombstoneDocSchema, { collection: 'upload_tombstones' })
UploadTombstoneSchema.index({ deleteAfter: 1 })
