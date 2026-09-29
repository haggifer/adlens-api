import { z } from 'zod'
import { zodToMongoose } from '../common/zod-to-mongoose'

export const RATE_LIMIT_MODEL = 'RateLimit'
export const RATE_LIMIT_COLLECTION = 'rate_limits'

// Better Auth's rate-limit counters (createRateLimitStorage), one per client and path, keyed by an HMAC of Better
// Auth's "<ip>|<path>" key so no address is stored. MongoDB deletes each one when its window ends.
export const rateLimitDocSchema = z.object({
    _id: z.string(),
    count: z.number(),
    windowStart: z.date(),
    expiresAt: z.date(),
})

export type RateLimitDoc = z.infer<typeof rateLimitDocSchema>

export const RateLimitSchema = zodToMongoose(rateLimitDocSchema, { collection: RATE_LIMIT_COLLECTION })
RateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
