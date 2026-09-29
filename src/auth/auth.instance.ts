import { Logger } from '@nestjs/common'
import { MIN_PASSWORD_LENGTH, RequestErrorCode } from 'adlens-shared'
import { betterAuth } from 'better-auth'
import { mongodbAdapter } from 'better-auth/adapters/mongodb'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { anonymous } from 'better-auth/plugins/anonymous'
import { type Db, type MongoClient, ObjectId } from 'mongodb'
import { AsyncLocalStorage } from 'node:async_hooks'
import { USER_COLLECTION } from '../database/user.doc'
import { passwordResetEmail, verificationEmail } from '../mail/auth-emails'
import type { Mailer, MailMessage } from '../mail/mailer'
import { isDisposableEmail } from './disposable-email'
import { createRateLimitStorage } from './rate-limit-storage'
import type { SocialProviderOptions } from './social-providers'

export const AUTH = 'BETTER_AUTH'

const RESET_TOKEN_TTL_S = 60 * 60

// Better Auth merges a create hook's data into the row, so the token fields are overwritten rather than omitted.
const NO_PROVIDER_TOKENS = {
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
}

// The client maps these Better Auth error codes to its own copy.
export const EMAIL_NOT_SENT = 'EMAIL_NOT_SENT'
const ACCOUNT_LINK_FAILED = 'ACCOUNT_LINK_FAILED'

// The anonymous plugin gives anonymous users `<id>@anonymous.placeholder.invalid` (createPlaceholderEmail in
// @better-auth/core); the .invalid TLD can never receive mail.
const ANONYMOUS_EMAIL_SUFFIX = '@anonymous.placeholder.invalid'

export interface AuthOptions {
    db: Db
    client: MongoClient
    secret: string
    baseURL: string
    webOrigin: string
    cookieDomain?: string
    socialProviders: SocialProviderOptions
    mailer: Mailer
    onDeleteUser: (userId: string) => Promise<void>
    onLinkAnonymous: (anonymousUserId: string, userId: string) => Promise<void>
}

const logger = new Logger('Auth')

// Better Auth calls its email callbacks through runInBackgroundOrAwait, which catches and only logs their errors, so a
// failed send would still answer success. The callbacks therefore only queue the message in the request's outbox, and
// the after hook below sends it and turns a failure into an error response.
const outbox = new AsyncLocalStorage<MailMessage[]>()

export const withOutbox = <T>(run: () => T): T => outbox.run([], run)

const queueMail = async (mailer: Mailer, message: MailMessage): Promise<void> => {
    // An anonymous user has no mailbox: a send would only fail the request.
    if (message.to.endsWith(ANONYMOUS_EMAIL_SUFFIX)) {
        return
    }

    const queue = outbox.getStore()

    if (!queue) {
        await mailer.send(message)
        return
    }

    queue.push(message)
}

// Emailed links open the web app, not Better Auth's own endpoints, so users only ever see the site's domain. The
// confirmation page confirms on load: a mail scanner that runs JavaScript could use the token up first.
const toWebLink = (webOrigin: string, path: string, token: string) =>
    `${webOrigin}${path}?token=${encodeURIComponent(token)}`

const normalizeEmail = (email: string): string => email.trim().toLowerCase()

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
    socialProviders,
    mailer,
    onDeleteUser,
    onLinkAnonymous,
}: AuthOptions) => {
    // Not a Better Auth field (no endpoint can set or return it): the email an anonymous session signed up with,
    // so onLinkAccount can check a /verify-email confirmation against it before linking.
    const pendingLinks = db.collection<{ pendingLinkEmail?: string | null }>(USER_COLLECTION)

    return betterAuth({
        database: mongodbAdapter(db, { client }),
        secret,
        baseURL,
        basePath: '/api/auth',
        trustedOrigins: [webOrigin],
        advanced: {
            // Better Auth skips its origin and callback-URL checks when NODE_ENV is test; keep them on so the tests
            // run with the same protection as production.
            disableOriginCheck: false,
            ...(cookieDomain && { crossSubDomainCookies: { enabled: true, domain: cookieDomain } }),
        },
        rateLimit: { customStorage: createRateLimitStorage(db, secret) },
        emailAndPassword: {
            enabled: true,
            requireEmailVerification: true,
            minPasswordLength: MIN_PASSWORD_LENGTH,
            resetPasswordTokenExpiresIn: RESET_TOKEN_TTL_S,
            revokeSessionsOnPasswordReset: true,
            sendResetPassword: async ({ user, token }) =>
                queueMail(mailer, passwordResetEmail(user.email, toWebLink(webOrigin, '/reset-password', token))),
        },
        socialProviders,
        emailVerification: {
            sendOnSignUp: true,
            sendOnSignIn: true,
            autoSignInAfterVerification: true,
            sendVerificationEmail: async ({ user, token }) =>
                queueMail(mailer, verificationEmail(user.email, toWebLink(webOrigin, '/confirm-email', token))),
        },
        user: {
            // Set by hand in the database (QuotaService lifts the analysis limit for admins). `input: false` keeps it
            // out of sign-up and profile updates, so no one can make themselves an admin.
            additionalFields: {
                isAdmin: { type: 'boolean', required: false, defaultValue: false, input: false },
            },
            deleteUser: {
                enabled: true,
                beforeDelete: async (user) => onDeleteUser(user.id),
            },
        },
        // AdLens only needs to know who signed in and never calls Google or GitHub for the user, so their tokens
        // aren't kept: cleared when an account is created, and not refreshed on later sign-ins.
        account: { updateAccountOnSignIn: false },
        databaseHooks: {
            // Better Auth records the client address on every session; AdLens never stores an address.
            session: {
                create: {
                    before: async (session) => ({ data: { ...session, ipAddress: null } }),
                },
            },
            account: {
                create: {
                    before: async (account) => ({ data: { ...account, ...NO_PROVIDER_TOKENS } }),
                },
            },
        },
        plugins: [
            anonymous({
                // Runs before the plugin deletes the anonymous user. That delete goes through the internal adapter,
                // which skips deleteUser.beforeDelete and so never purges the videos the moved jobs still point at.
                // An APIError stops the delete, so a failed move leaves the anonymous user and its data in place.
                onLinkAccount: async ({ anonymousUser, newUser, ctx }) => {
                    // A verify-email confirmation can be opened by anyone who has the link, not just the visitor who
                    // requested it: an attacker can sign up with their own address and mail the confirmation link to
                    // a visitor, hijacking that visitor's anonymous history if we linked unconditionally. Password
                    // and social sign-in need the visitor's own credentials or the OAuth state, so they keep linking
                    // as designed.
                    if (ctx.path === '/verify-email') {
                        const pending = await pendingLinks.findOne({ _id: new ObjectId(anonymousUser.user.id) })
                        const confirmedEmail = normalizeEmail(newUser.user.email)

                        if (!pending?.pendingLinkEmail || pending.pendingLinkEmail !== confirmedEmail) {
                            logger.error(
                                `refused to link anonymous user ${anonymousUser.user.id} to user ${newUser.user.id}: the confirmed email does not match the sign-up that started the anonymous session`,
                            )
                            throw new APIError('FORBIDDEN', {
                                code: ACCOUNT_LINK_FAILED,
                                message: 'This confirmation link does not match the analyses you started',
                            })
                        }
                    }

                    try {
                        await onLinkAnonymous(anonymousUser.user.id, newUser.user.id)
                    } catch (err) {
                        logger.error(
                            `could not move anonymous user ${anonymousUser.user.id} to user ${newUser.user.id}: ${err instanceof Error ? err.message : err}`,
                        )
                        throw new APIError('INTERNAL_SERVER_ERROR', {
                            code: ACCOUNT_LINK_FAILED,
                            message: 'The earlier analyses could not be moved',
                        })
                    }
                },
            }),
        ],
        hooks: {
            before: createAuthMiddleware(async (ctx) => {
                // That endpoint also deletes through the internal adapter, skipping the purge and orphaning the
                // user's jobs and uploads.
                if (ctx.path === '/delete-anonymous-user') {
                    throw new APIError('NOT_FOUND', { message: 'Not found' })
                }

                // Otherwise an anonymous user could attach a provider and stay anonymous forever, with no email or
                // password of their own to ever link their history to a real account.
                if (ctx.path === '/link-social') {
                    const session = await getSessionFromCtx(ctx)

                    if (session?.user.isAnonymous) {
                        throw new APIError('FORBIDDEN', {
                            code: ACCOUNT_LINK_FAILED,
                            message: 'Sign up or sign in before linking a provider',
                        })
                    }
                }

                if (ctx.path === '/sign-up/email') {
                    const email = String(ctx.body?.email ?? '')

                    if (isDisposableEmail(email)) {
                        throw new APIError('BAD_REQUEST', {
                            code: RequestErrorCode.DisposableEmail,
                            message: 'Sign up with a permanent email address',
                        })
                    }

                    const session = await getSessionFromCtx(ctx)

                    // Recorded so onLinkAccount can check a later /verify-email confirmation against it.
                    if (session?.user.isAnonymous) {
                        await pendingLinks.updateOne(
                            { _id: new ObjectId(session.user.id) },
                            { $set: { pendingLinkEmail: normalizeEmail(email) } },
                        )
                    }
                }
            }),
            after: createAuthMiddleware(async () => sendQueuedMail(mailer)),
        },
    })
}

export type AuthInstance = ReturnType<typeof createAuth>
