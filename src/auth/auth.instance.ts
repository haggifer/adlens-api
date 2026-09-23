import { betterAuth } from 'better-auth'
import { mongodbAdapter } from 'better-auth/adapters/mongodb'
import { bearer } from 'better-auth/plugins'
import type { Db, MongoClient } from 'mongodb'

export const AUTH = 'BETTER_AUTH'

export interface AuthOptions {
    db: Db
    client: MongoClient
    secret: string
    baseURL: string
    trustedOrigins: string[]
}

// Better Auth server instance on the app's own Mongo connection. The bearer plugin lets the cross-origin web client
// authenticate with an Authorization header instead of a cookie.
export const createAuth = ({ db, client, secret, baseURL, trustedOrigins }: AuthOptions) =>
    betterAuth({
        database: mongodbAdapter(db, { client }),
        secret,
        baseURL,
        basePath: '/api/auth',
        trustedOrigins,
        emailAndPassword: { enabled: true },
        plugins: [bearer()],
    })

export type AuthInstance = ReturnType<typeof createAuth>
