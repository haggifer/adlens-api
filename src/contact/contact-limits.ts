import type { BetterAuthRateLimitStorage } from 'better-auth'
import type { Db } from 'mongodb'
import { createRateLimitStorage } from '../auth/rate-limit-storage'

const WINDOW_S = 60 * 60
const PER_NETWORK = { window: WINDOW_S, max: 3 }
const PER_SENDER = { window: WINDOW_S, max: 3 }
// Senders choose their email and can switch networks, so the hard guarantee against a flooded inbox and a spent
// Resend quota (shared with confirmation and reset emails) is a global cap.
const TOTAL = { window: WINDOW_S, max: 20 }
const UPLOADS_PER_NETWORK = { window: WINDOW_S, max: 3 }

// The Contact form's hourly caps, counted like Better Auth's rate limits: one atomic upsert per counter, under a keyed
// hash, so concurrent requests can't exceed a cap and neither the sender nor the network is stored.
export class ContactLimits {
    private readonly counters: BetterAuthRateLimitStorage

    constructor(db: Db, secret: string, now: () => number = Date.now) {
        this.counters = createRateLimitStorage(db, secret, now)
    }

    private async consume(key: string, rule: { window: number; max: number }): Promise<boolean> {
        const { allowed } = await this.counters.consume(`contact|${key}`, rule)

        return allowed
    }

    async allowUploads(networkKey: string): Promise<boolean> {
        return this.consume(`uploads|network|${networkKey}`, UPLOADS_PER_NETWORK)
    }

    // Narrowest first, and only while each passes, so a message one cap refuses never uses up a wider one: a sender
    // repeating themselves can't lock the form for everyone.
    async allowMessage(networkKey: string, email: string): Promise<boolean> {
        const isNetworkAllowed = await this.consume(`message|network|${networkKey}`, PER_NETWORK)

        if (!isNetworkAllowed) {
            return false
        }

        const isSenderAllowed = await this.consume(`message|sender|${email}`, PER_SENDER)

        if (!isSenderAllowed) {
            return false
        }

        return this.consume('message|total', TOTAL)
    }
}
