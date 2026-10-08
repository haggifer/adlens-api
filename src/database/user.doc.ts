import type { Types } from 'mongoose'

export interface QuotaRun {
    id: string
    startedAt: Date
    jobId: string
}

// Better Auth owns the `user` collection. These are the fields AdLens reads or adds: `isAdmin` (set by hand),
// `isAnonymous` (set by Better Auth's anonymous plugin), `emailVerified` (Better Auth's), `runs` and `freeRunId` (written
// by QuotaService) and `lastSeenAt` (written by auth.instance.ts), never through Better Auth's endpoints.
export interface UserExtras {
    _id: Types.ObjectId
    isAdmin?: boolean
    isAnonymous?: boolean
    emailVerified?: boolean
    // Only the runs still inside the quota window: older ones are dropped on every charge.
    runs?: QuotaRun[]
    // The run of the one analysis allowed before the email is confirmed, kept for good (unlike `runs`), moved onto the
    // account an anonymous user signs up with, and cleared when that run is refunded.
    freeRunId?: string | null
    // Anonymous users only: when their session was last created or refreshed (Better Auth refreshes it at most once a
    // day). AnonymousCleanupService deletes them a week after it.
    lastSeenAt?: Date
    createdAt?: Date
}

export const USER_COLLECTION = 'user'
