import { z } from 'zod'
import { zodToMongoose } from '../common/zod-to-mongoose'

export const RATE_LIMIT_MODEL = 'RateLimit'
export const RATE_LIMIT_COLLECTION = 'rate_limits'

// Rate-limit counters (createRateLimitStorage): Better Auth's, one per client and path, the per-address email caps and
// the Contact form's caps (ContactLimits). Each is keyed by an HMAC of its raw key ("<ip>|<path>", an email, a network
// key), so no address is stored. MongoDB deletes each one when its window ends.
export const rateLimitDocSchema = z.object({
    _id: z.string(),
    count: z.number(),
    windowStart: z.date(),
    expiresAt: z.date(),
})

export type RateLimitDoc = z.infer<typeof rateLimitDocSchema>

export const RateLimitSchema = zodToMongoose(rateLimitDocSchema, { collection: RATE_LIMIT_COLLECTION })
RateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
