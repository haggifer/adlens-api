import { Logger } from '@nestjs/common'
import { MIN_PASSWORD_LENGTH, RequestErrorCode } from 'adlens-shared'
import { betterAuth } from 'better-auth'
import { mongodbAdapter } from 'better-auth/adapters/mongodb'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { verifyJWT } from 'better-auth/crypto'
import { anonymous } from 'better-auth/plugins/anonymous'
import { type Db, type MongoClient, ObjectId } from 'mongodb'
import { AsyncLocalStorage } from 'node:async_hooks'
import { format } from 'node:util'
import { describeError } from '../common/error-message'
import { allowedWebOrigins } from '../config/web-origins'
import { USER_COLLECTION } from '../database/user.doc'
import { moveFreeRunCookie } from '../jobs/free-run-cookie'
import { passwordResetEmail, verificationEmail } from '../mail/auth-emails'
import type { Mailer, MailMessage } from '../mail/mailer'
import { ACCOUNT_LINK_FAILED, EMAIL_MISMATCH, EMAIL_NOT_SENT, SIGN_IN_REQUIRED } from './auth-error-codes'
import { isDisposableEmail } from './disposable-email'
import { createRateLimitStorage } from './rate-limit-storage'
import type { SocialProviderOptions } from './social-providers'

type AuthEmailKind = 'confirmation' | 'reset'

type BetterAuthLogLevel = 'debug' | 'info' | 'warn' | 'error'

interface AuthOptions {
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

export const AUTH = 'BETTER_AUTH'

const RESET_TOKEN_TTL_S = 60 * 60

// Bounds how many anonymous users one client can create by calling the API directly; the web only signs in
// anonymously right before a first analysis.
const ANONYMOUS_SIGN_IN_LIMIT = { window: 60 * 60, max: 10 }

// Emails of one kind to one address per hour, whoever asks for them.
const MAIL_PER_ADDRESS_LIMIT = { window: 60 * 60, max: 5 }

// Better Auth merges a create hook's data into the row, so the token fields are overwritten rather than omitted.
const NO_PROVIDER_TOKENS = {
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
}

// The anonymous plugin gives anonymous users `<id>@anonymous.placeholder.invalid` (createPlaceholderEmail in
// @better-auth/core); the .invalid TLD can never receive mail.
const ANONYMOUS_EMAIL_SUFFIX = '@anonymous.placeholder.invalid'

const logger = new Logger('Auth')

// Better Auth calls its email callbacks through runInBackgroundOrAwait, which catches and only logs their errors, so a
// failed send would still answer success. The callbacks therefore only queue the message in the request's outbox, and
// the after hook below sends it and turns a failure into an error response.
const outbox = new AsyncLocalStorage<MailMessage[]>()

// Better Auth prints its own coloured lines by default; through Nest's logger they get a level on Cloud Logging too.
const logBetterAuth = (level: BetterAuthLogLevel, message: string, ...args: unknown[]): void => {
    const text = format(message, ...args)

    switch (level) {
        case 'error':
            logger.error(text)
            return
        case 'warn':
            logger.warn(text)
            return
        case 'debug':
            logger.debug(text)
            return
        default:
            logger.log(text)
    }
}

// An anonymous user has no mailbox: a send would only fail the request.
const isPlaceholderAddress = (address: string): boolean => address.endsWith(ANONYMOUS_EMAIL_SUFFIX)

const queueMail = async (mailer: Mailer, message: MailMessage): Promise<void> => {
    if (isPlaceholderAddress(message.to)) {
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
// confirmation page confirms from the browser once it loads, and only in the account's own session (the /verify-email
// hook below), so a mail scanner that fetches the link confirms nothing.
const toWebLink = (webOrigin: string, path: string, token: string) =>
    `${webOrigin}${path}?token=${encodeURIComponent(token)}`

const normalizeEmail = (email: string): string => email.trim().toLowerCase()

// The address a confirmation token was issued for, read the way Better Auth's /verify-email reads it. null for a token
// it will refuse (malformed, expired or signed with another secret), so its own error answers.
const getTokenEmail = async (token: unknown, secret: string): Promise<string | null> => {
    if (typeof token !== 'string') {
        return null
    }

    const payload = await verifyJWT(token, secret)

    return typeof payload?.email === 'string' ? normalizeEmail(payload.email) : null
}

// Better Auth answers an after hook's APIError with the endpoint's own response headers merged in, so a sign-up whose
// confirmation email failed still sets the new account's session cookie: the user is signed in, unconfirmed, and can
// resend the email (auth-flow tests pin this).
const sendQueuedMail = async (mailer: Mailer): Promise<void> => {
    const messages = outbox.getStore()?.splice(0) ?? []

    try {
        await Promise.all(messages.map((message) => mailer.send(message)))
    } catch (err) {
        logger.error(`could not send an auth email: ${describeError(err)}`)
        throw new APIError('SERVICE_UNAVAILABLE', { code: EMAIL_NOT_SENT, message: 'The email could not be sent' })
    }
}

export const withOutbox = <T>(run: () => T): T => outbox.run([], run)

// Better Auth on the app's Mongo connection. Sessions are httpOnly, SameSite=Lax cookies: in production the API
// (api.useadlens.com) and the web app (www.useadlens.com) share the parent domain, so the cookie is first-party for
// both.
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
    const anonymousUsers = db.collection<{ isAnonymous?: boolean; lastSeenAt?: Date }>(USER_COLLECTION)
    // Secure only over HTTPS, as JobsController writes it: locally the API runs on plain http://localhost.
    const isSecureCookie = new URL(baseURL).protocol === 'https:'
    const rateLimits = createRateLimitStorage(db, secret)

    // Fails open: a database blip must not stop a real user's email.
    const isMailAllowed = async (kind: AuthEmailKind, address: string): Promise<boolean> => {
        try {
            const { allowed } = await rateLimits.consume(
                `email|${kind}|${normalizeEmail(address)}`,
                MAIL_PER_ADDRESS_LIMIT,
            )

            return allowed
        } catch (err) {
            logger.error(`could not check the ${kind} email limit: ${describeError(err)}`)
            return true
        }
    }

    // Anyone can ask for an unconfirmed account's link again (/send-verification-email), so without a cap anyone could
    // flood an inbox and use up the day's sending quota. Counted like the rate limits, under a keyed hash of the
    // address; past the cap nothing is sent and the request still answers as usual, so the cap reveals nothing about
    // the account.
    const queueCappedMail = async (kind: AuthEmailKind, message: MailMessage): Promise<void> => {
        if (isPlaceholderAddress(message.to)) {
            return
        }

        const isAllowed = await isMailAllowed(kind, message.to)

        if (!isAllowed) {
            logger.warn(`a ${kind} email was not sent: its address reached the hourly limit`)
            return
        }

        await queueMail(mailer, message)
    }

    // AnonymousCleanupService deletes an anonymous user a week after this. Sign-out deletes the session, so the time
    // must live on the user. A failed write only logs: the cleanup never deletes a user whose session is still live.
    const markSeen = async (session: { userId?: unknown } | null): Promise<void> => {
        const userId = String(session?.userId ?? '')

        if (!ObjectId.isValid(userId)) {
            return
        }

        try {
            await anonymousUsers.updateOne(
                { _id: new ObjectId(userId), isAnonymous: true },
                { $set: { lastSeenAt: new Date() } },
            )
        } catch (err) {
            logger.error(`could not mark user ${userId} as seen: ${describeError(err)}`)
        }
    }

    return betterAuth({
        database: mongodbAdapter(db, { client }),
        secret,
        baseURL,
        basePath: '/api/auth',
        logger: { log: logBetterAuth },
        trustedOrigins: allowedWebOrigins(webOrigin),
        advanced: {
            // Better Auth skips its origin and callback-URL checks when NODE_ENV is test; keep them on so the tests
            // run with the same protection as production.
            disableOriginCheck: false,
            ...(cookieDomain && { crossSubDomainCookies: { enabled: true, domain: cookieDomain } }),
        },
        rateLimit: {
            customStorage: rateLimits,
            customRules: { '/sign-in/anonymous': ANONYMOUS_SIGN_IN_LIMIT },
        },
        emailAndPassword: {
            enabled: true,
            // An unconfirmed account signs in (and is signed in at sign-up) but is limited like an anonymous user
            // until it confirms.
            requireEmailVerification: false,
            minPasswordLength: MIN_PASSWORD_LENGTH,
            resetPasswordTokenExpiresIn: RESET_TOKEN_TTL_S,
            revokeSessionsOnPasswordReset: true,
            sendResetPassword: async ({ user, token }) =>
                queueCappedMail(
                    'reset',
                    passwordResetEmail(user.email, toWebLink(webOrigin, '/reset-password', token)),
                ),
        },
        socialProviders,
        emailVerification: {
            sendOnSignUp: true,
            // A confirmation link never creates a session: anyone the link reaches could otherwise be signed in to
            // the account. The /verify-email hook below only lets the account's own session confirm it.
            autoSignInAfterVerification: false,
            sendVerificationEmail: async ({ user, token }) =>
                queueCappedMail(
                    'confirmation',
                    verificationEmail(user.email, toWebLink(webOrigin, '/confirm-email', token)),
                ),
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
                    after: markSeen,
                },
                // Also runs after an updateMany, with a count instead of a session; markSeen ignores that.
                update: { after: async (session) => markSeen(typeof session === 'object' ? session : null) },
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
                // Sign-up and sign-in link (they need the visitor's new password or own credentials); /verify-email
                // never does, since it never creates a session.
                onLinkAccount: async ({ anonymousUser, newUser, ctx }) => {
                    const fromId = anonymousUser.user.id
                    const toId = newUser.user.id

                    try {
                        await onLinkAnonymous(fromId, toId)
                    } catch (err) {
                        logger.error(`could not move anonymous user ${fromId} to user ${toId}: ${describeError(err)}`)
                        throw new APIError('INTERNAL_SERVER_ERROR', {
                            code: ACCOUNT_LINK_FAILED,
                            message: 'The earlier analyses could not be moved',
                        })
                    }

                    moveFreeRunCookie(ctx, fromId, toId, isSecureCookie)
                },
            }),
        ],
        hooks: {
            before: createAuthMiddleware(async (ctx) => {
                switch (ctx.path) {
                    // That endpoint also deletes through the internal adapter, skipping the purge and orphaning the
                    // user's jobs and uploads.
                    case '/delete-anonymous-user':
                        throw new APIError('NOT_FOUND', { message: 'Not found' })
                    // Otherwise an anonymous user could attach a provider and stay anonymous forever, with no email or
                    // password of their own to ever link their history to a real account; an unconfirmed account is
                    // limited the same way until it confirms.
                    case '/link-social': {
                        const session = await getSessionFromCtx(ctx)

                        if (session && (session.user.isAnonymous || !session.user.emailVerified)) {
                            throw new APIError('FORBIDDEN', {
                                code: ACCOUNT_LINK_FAILED,
                                message: 'Sign up or sign in, and confirm your email, before linking a provider',
                            })
                        }

                        return
                    }
                    // Only the account's own session may confirm its email: anyone the link reaches (a forwarded mail,
                    // a link mailed to a visitor on purpose) could otherwise confirm an address, or act in a session,
                    // that isn't theirs. With no account session the web asks the visitor to sign in and opens the
                    // link again.
                    case '/verify-email': {
                        const tokenEmail = await getTokenEmail(ctx.query?.token, ctx.context.secret)

                        if (!tokenEmail) {
                            return
                        }

                        // No refresh, so a refused request never sets a cookie.
                        const session = await getSessionFromCtx(ctx, { disableRefresh: true })

                        if (!session || session.user.isAnonymous) {
                            throw new APIError('UNAUTHORIZED', {
                                code: SIGN_IN_REQUIRED,
                                message: 'Sign in to confirm your email',
                            })
                        }

                        if (normalizeEmail(session.user.email) !== tokenEmail) {
                            throw new APIError('FORBIDDEN', {
                                code: EMAIL_MISMATCH,
                                message: 'This link is for a different account',
                            })
                        }

                        return
                    }
                    case '/sign-up/email':
                        if (isDisposableEmail(String(ctx.body?.email ?? ''))) {
                            throw new APIError('BAD_REQUEST', {
                                code: RequestErrorCode.DisposableEmail,
                                message: 'Sign up with a permanent email address',
                            })
                        }
                }
            }),
            after: createAuthMiddleware(async () => sendQueuedMail(mailer)),
        },
    })
}

export type AuthInstance = ReturnType<typeof createAuth>
