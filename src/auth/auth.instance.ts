import { Logger } from '@nestjs/common'
import { betterAuth } from 'better-auth'
import { mongodbAdapter } from 'better-auth/adapters/mongodb'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Db, MongoClient } from 'mongodb'
import { passwordResetEmail, verificationEmail } from '../mail/auth-emails'
import type { Mailer, MailMessage } from '../mail/mailer'

export const AUTH = 'BETTER_AUTH'

const RESET_TOKEN_TTL_S = 60 * 60

// The client maps this Better Auth error code to its own copy.
export const EMAIL_NOT_SENT = 'EMAIL_NOT_SENT'

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

// Better Auth calls its email callbacks through runInBackgroundOrAwait, which catches and only logs their errors, so a
// failed send would still answer success. The callbacks therefore only queue the message in the request's outbox, and
// the after hook below sends it and turns a failure into an error response.
const outbox = new AsyncLocalStorage<MailMessage[]>()

// Wraps each HTTP request to Better Auth (see main.ts), giving it its own outbox.
export const withOutbox = <T>(run: () => T): T => outbox.run([], run)

const queueMail = async (mailer: Mailer, message: MailMessage): Promise<void> => {
    const queue = outbox.getStore()

    if (!queue) {
        await mailer.send(message)
        return
    }

    queue.push(message)
}

// Emailed links open the web app, not Better Auth's own endpoints: users only ever see the site's domain, and the
// pages confirm on a button press, so mail scanners that open every link can't use the token up first.
const toWebLink = (webOrigin: string, path: string, token: string) =>
    `${webOrigin}${path}?token=${encodeURIComponent(token)}`

const sendQueuedMail = async (mailer: Mailer): Promise<void> => {
    const messages = outbox.getStore()?.splice(0) ?? []

    try {
        await Promise.all(messages.map((message) => mailer.send(message)))
    } catch (err) {
        logger.error(`could not send an auth email: ${err instanceof Error ? err.message : err}`)
        throw new APIError('SERVICE_UNAVAILABLE', { code: EMAIL_NOT_SENT, message: 'The email could not be sent' })
    }
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
            sendResetPassword: async ({ user, token }) =>
                queueMail(mailer, passwordResetEmail(user.email, toWebLink(webOrigin, '/reset-password', token))),
        },
        emailVerification: {
            sendOnSignUp: true,
            sendOnSignIn: true,
            autoSignInAfterVerification: true,
            sendVerificationEmail: async ({ user, token }) =>
                queueMail(mailer, verificationEmail(user.email, toWebLink(webOrigin, '/confirm-email', token))),
        },
        user: {
            deleteUser: {
                enabled: true,
                beforeDelete: async (user) => onDeleteUser(user.id),
            },
        },
        hooks: {
            after: createAuthMiddleware(async () => sendQueuedMail(mailer)),
        },
    })

export type AuthInstance = ReturnType<typeof createAuth>
