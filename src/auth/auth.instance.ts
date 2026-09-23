import { Logger } from '@nestjs/common'
import { betterAuth } from 'better-auth'
import { mongodbAdapter } from 'better-auth/adapters/mongodb'
import type { Db, MongoClient } from 'mongodb'
import { passwordResetEmail, verificationEmail } from '../mail/auth-emails'
import type { Mailer, MailMessage } from '../mail/mailer'

export const AUTH = 'BETTER_AUTH'

const RESET_TOKEN_TTL_S = 60 * 60

export interface AuthOptions {
    db: Db
    client: MongoClient
    secret: string
    baseURL: string
    webOrigin: string
    cookieDomain?: string
    mailer: Mailer
    onDeleteUser: (userId: string) => Promise<void>
}

const logger = new Logger('Auth')

// Emails are sent without awaiting them, so response timing doesn't reveal whether an address has an account.
const sendInBackground = (mailer: Mailer, message: MailMessage): void => {
    mailer.send(message).catch((err: unknown) => {
        logger.error(`could not send "${message.subject}": ${err instanceof Error ? err.message : err}`)
    })
}

// Better Auth on the app's Mongo connection. Sessions are httpOnly, SameSite=Lax cookies: in production the API
// (api.useadlens.com) and the web app (www.useadlens.com) share the parent domain, so the cookie is first-party for both.
export const createAuth = ({
    db,
    client,
    secret,
    baseURL,
    webOrigin,
    cookieDomain,
    mailer,
    onDeleteUser,
}: AuthOptions) =>
    betterAuth({
        database: mongodbAdapter(db, { client }),
        secret,
        baseURL,
        basePath: '/api/auth',
        trustedOrigins: [webOrigin],
        advanced: cookieDomain ? { crossSubDomainCookies: { enabled: true, domain: cookieDomain } } : undefined,
        rateLimit: { storage: 'database' },
        emailAndPassword: {
            enabled: true,
            requireEmailVerification: true,
            minPasswordLength: 8,
            resetPasswordTokenExpiresIn: RESET_TOKEN_TTL_S,
            revokeSessionsOnPasswordReset: true,
            sendResetPassword: async ({ user, url }) => sendInBackground(mailer, passwordResetEmail(user.email, url)),
        },
        emailVerification: {
            sendOnSignUp: true,
            sendOnSignIn: true,
            autoSignInAfterVerification: true,
            sendVerificationEmail: async ({ user, url }) =>
                sendInBackground(mailer, verificationEmail(user.email, url)),
        },
        user: {
            deleteUser: {
                enabled: true,
                beforeDelete: async (user) => onDeleteUser(user.id),
            },
        },
    })

export type AuthInstance = ReturnType<typeof createAuth>
