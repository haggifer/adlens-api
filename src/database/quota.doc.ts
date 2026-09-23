import { z } from 'zod'
import { zodToMongoose } from '../common/zod-to-mongoose'

export const QUOTA_MODEL = 'Quota'

export const quotaDocSchema = z.object({
    userId: z.string(),
    used: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive(),
    windowStart: z.date().nullable(),
})

export type QuotaDoc = z.infer<typeof quotaDocSchema>

export const QuotaSchema = zodToMongoose(quotaDocSchema, { collection: 'quotas' })
QuotaSchema.index({ userId: 1 }, { unique: true })
