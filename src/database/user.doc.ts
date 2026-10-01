import type { Types } from 'mongoose'

// Better Auth owns the `user` collection. These are the fields AdLens reads or adds: `isAdmin` (set by hand),
// `isAnonymous` (set by Better Auth's anonymous plugin), `emailVerified` (Better Auth's), `runs` (written by
// QuotaService) and `lastSeenAt` (written by auth.instance.ts), never through Better Auth's endpoints.
export const USER_COLLECTION = 'user'

export interface QuotaRun {
    id: string
    startedAt: Date
    jobId: string
}

export interface UserExtras {
    _id: Types.ObjectId
    isAdmin?: boolean
    isAnonymous?: boolean
    emailVerified?: boolean
    // Only the runs still inside the quota window: older ones are dropped on every charge.
    runs?: QuotaRun[]
    // Anonymous users only: when their session was last created or refreshed (Better Auth refreshes it at most once a
    // day). AnonymousCleanupService deletes them a week after it.
    lastSeenAt?: Date
    createdAt?: Date
}
