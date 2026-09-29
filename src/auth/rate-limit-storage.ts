import type { BetterAuthRateLimitStorage } from 'better-auth'
import type { Db } from 'mongodb'
import { RATE_LIMIT_COLLECTION, type RateLimitDoc } from '../database/rate-limit.doc'
import { deriveRateLimitKey, hashBucket } from '../ip-quota/ip-key'

const DUPLICATE_KEY = 11000
const EPOCH = new Date(0)

type Consume = BetterAuthRateLimitStorage['consume']

// Better Auth's own database storage keeps its "<ip>|<path>" keys in the clear and never deletes them, so this one
// stores an HMAC of the key and lets MongoDB delete each counter when its window ends. The counters stay in MongoDB so
// the limits hold across instances. One pipeline upsert counts the request, so concurrent requests can't overdraw.
export const createRateLimitStorage = (
    db: Db,
    secret: string,
    now: () => number = Date.now,
): BetterAuthRateLimitStorage => {
    const key = deriveRateLimitKey(secret)
    const counters = db.collection<RateLimitDoc>(RATE_LIMIT_COLLECTION)

    const count = (id: string, windowMs: number, at: number) => {
        const isNewWindow = { $lte: [{ $ifNull: ['$windowStart', EPOCH] }, new Date(at - windowMs)] }

        return counters.findOneAndUpdate(
            { _id: id },
            [
                {
                    $set: {
                        count: { $cond: [isNewWindow, 1, { $add: ['$count', 1] }] },
                        windowStart: { $cond: [isNewWindow, new Date(at), '$windowStart'] },
                    },
                },
                { $set: { expiresAt: { $add: ['$windowStart', windowMs] } } },
            ],
            { upsert: true, returnDocument: 'after' },
        )
    }

    const consume: Consume = async (rawKey, { window, max }) => {
        const id = hashBucket(key, rawKey)
        const windowMs = window * 1000
        const at = now()
        let counter: RateLimitDoc | null

        try {
            counter = await count(id, windowMs, at)
        } catch (err) {
            // Two first requests raced to create the counter; the loser's duplicate-key error only means it exists.
            if ((err as { code?: unknown })?.code !== DUPLICATE_KEY) {
                throw err
            }

            counter = await count(id, windowMs, at)
        }

        if (!counter || counter.count <= max) {
            return { allowed: true, retryAfter: null }
        }

        return { allowed: false, retryAfter: Math.max(1, Math.ceil((counter.expiresAt.getTime() - at) / 1000)) }
    }

    return { consume }
}
