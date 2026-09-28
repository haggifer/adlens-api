import type { Types } from 'mongoose'

// Better Auth owns the `user` collection. These are the fields AdLens adds to its documents, written by hand
// (`isAdmin`) or by AdLens's own code (`runs`), never through Better Auth's endpoints.
export const USER_COLLECTION = 'user'

export interface QuotaRun {
    id: string
    startedAt: Date
    jobId: string
}

export interface UserExtras {
    _id: Types.ObjectId
    isAdmin?: boolean
    // Only the runs still inside the quota window: older ones are dropped on every charge.
    runs?: QuotaRun[]
}
