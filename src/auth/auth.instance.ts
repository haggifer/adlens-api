import { betterAuth } from 'better-auth'
import { mongodbAdapter } from 'better-auth/adapters/mongodb'
import { bearer } from 'better-auth/plugins'
import { MongoClient } from 'mongodb'

export const AUTH = 'BETTER_AUTH'

export interface AuthOptions {
    mongoUri: string
    secret: string
    baseURL: string
    trustedOrigins: string[]
}

// Better Auth server instance. Uses its own MongoClient (same cluster) so it is independent of the
// Mongoose connection lifecycle. The bearer plugin lets the cross-origin web client authenticate with
// an Authorization header instead of a cookie (simplest for Vercel web → Cloud Run API).
export const createAuth = ({ mongoUri, secret, baseURL, trustedOrigins }: AuthOptions) => {
    const client = new MongoClient(mongoUri)
    const db = client.db()

    return betterAuth({
        database: mongodbAdapter(db, { client }),
        secret,
        baseURL,
        basePath: '/api/auth',
        trustedOrigins,
        emailAndPassword: { enabled: true },
        plugins: [bearer()],
    })
}

export type AuthInstance = ReturnType<typeof createAuth>
