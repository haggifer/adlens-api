import type { BetterAuthRateLimitStorage } from 'better-auth'
import type { Db } from 'mongodb'
import { createRateLimitStorage } from '../auth/rate-limit-storage'

interface LimitRule {
    window: number
    max: number
}

// Far above what the web does (one list per page, one request per click), so only a script or a runaway loop meets
// them. Each preset document is capped anyway; these bound the work and the writes one account can cause.
export const READS_PER_USER: LimitRule = { window: 60, max: 300 }
export const WRITES_PER_USER: LimitRule = { window: 60, max: 60 }

// Per-user caps on the preset routes, counted like Better Auth's rate limits: one atomic upsert per counter, under a
// keyed hash, in the shared rate-limit collection.
export class PresetLimits {
    private readonly counters: BetterAuthRateLimitStorage

    constructor(db: Db, secret: string, now: () => number = Date.now) {
        this.counters = createRateLimitStorage(db, secret, now)
    }

    async allow(userId: string, isWrite: boolean): Promise<boolean> {
        const rule = isWrite ? WRITES_PER_USER : READS_PER_USER
        const { allowed } = await this.counters.consume(`presets|${isWrite ? 'write' : 'read'}|${userId}`, rule)

        return allowed
    }
}
