import type { Connection, mongo } from 'mongoose'
import { USER_COLLECTION } from '../database/user.doc'

interface AuthIndex {
    collection: string
    index: mongo.IndexDescription & { name: string }
}

interface AuthIndexFailure {
    collection: string
    name: string
    reason: string
}

// Better Auth's Mongo adapter only creates indexes a plugin schema declares, and none does, so its collections would
// have nothing but `_id` and every session check would scan `session`. These back the adapter's lookups (README,
// "Authentication"). The names follow Better Auth's own `<table>_<fields>_<idx|uidx>`.
export const AUTH_INDEXES: AuthIndex[] = [
    { collection: 'session', index: { name: 'session_token_uidx', key: { token: 1 }, unique: true } },
    { collection: 'session', index: { name: 'session_userId_idx', key: { userId: 1 } } },
    // Better Auth deletes an expired session only when its cookie comes back, so abandoned ones would stay forever.
    { collection: 'session', index: { name: 'session_expiresAt_ttl', key: { expiresAt: 1 }, expireAfterSeconds: 0 } },
    { collection: USER_COLLECTION, index: { name: 'user_email_uidx', key: { email: 1 }, unique: true } },
    { collection: 'account', index: { name: 'account_userId_idx', key: { userId: 1 } } },
    {
        collection: 'account',
        index: { name: 'account_providerId_accountId_idx', key: { providerId: 1, accountId: 1 } },
    },
    { collection: 'verification', index: { name: 'verification_identifier_idx', key: { identifier: 1 } } },
    {
        collection: 'verification',
        index: { name: 'verification_expiresAt_ttl', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    },
]

// Only the error's name and code: a duplicate-key message quotes the duplicate value, which can be an email address.
export const describeIndexFailure = (err: unknown): string => {
    const { name, codeName, code } = (err ?? {}) as { name?: unknown; codeName?: unknown; code?: unknown }
    const parts = [name, codeName, code].filter((part) => part !== undefined)

    return parts.length ? parts.join(' ') : 'unknown error'
}

// All indexes at once, each on its own, so one the data can't satisfy (duplicate emails, say) never takes the
// others with it. Creating an index that already exists with the same name and options is a no-op.
export const ensureAuthIndexes = async (connection: Connection): Promise<AuthIndexFailure[]> => {
    const results = await Promise.allSettled(
        AUTH_INDEXES.map(({ collection, index }) => connection.collection(collection).createIndexes([index])),
    )

    return results.flatMap((result, i) =>
        result.status === 'rejected'
            ? [
                  {
                      collection: AUTH_INDEXES[i].collection,
                      name: AUTH_INDEXES[i].index.name,
                      reason: describeIndexFailure(result.reason),
                  },
              ]
            : [],
    )
}
