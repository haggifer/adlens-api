import type { Request, Response } from 'express'

interface FreeRunCookieOptions {
    httpOnly: boolean
    secure: boolean
    sameSite: 'lax'
    path: string
    maxAge: number
}

// The parts of Better Auth's endpoint context the link hook uses to move the cookie.
interface AuthCookieContext {
    headers?: Headers
    setCookie: (name: string, value: string, options: FreeRunCookieOptions) => unknown
}

// A browser gets one analysis before an email is confirmed, whoever runs it. Signing in moves the anonymous user that
// used it to the account and deletes it, so after signing out a new anonymous session (or a new unconfirmed account)
// would get another; this cookie remembers who last ran an analysis in the browser. Clearing cookies gets around it,
// which the network's anonymous allowance still bounds.
export const FREE_RUN_COOKIE = 'adlens_free_run'

// For good, as far as browsers allow: Chrome caps a cookie's lifetime at 400 days.
const FREE_RUN_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60

// Host-only on the API, which alone reads it. Express takes maxAge in milliseconds, Better Auth in seconds.
const toCookieOptions = (isSecure: boolean, maxAge: number): FreeRunCookieOptions => ({
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
    path: '/',
    maxAge,
})

// A value that isn't valid percent-encoding (a stray `%`) can only come from a hand-edited cookie: read as none.
const decodeCookieValue = (value: string): string | null => {
    try {
        return decodeURIComponent(value) || null
    } catch {
        return null
    }
}

const parseFreeRunUserId = (cookieHeader: string | null | undefined): string | null => {
    const prefix = `${FREE_RUN_COOKIE}=`
    const pair = (cookieHeader ?? '')
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(prefix))

    return pair ? decodeCookieValue(pair.slice(prefix.length)) : null
}

export const readFreeRunUserId = (req: Request): string | null => parseFreeRunUserId(req.headers.cookie)

export const writeFreeRunCookie = (res: Response, userId: string, isSecure: boolean): void => {
    res.cookie(FREE_RUN_COOKIE, userId, toCookieOptions(isSecure, FREE_RUN_COOKIE_MAX_AGE_S * 1000))
}

// Linking deletes the anonymous user, and a cookie still naming it would count as a used run for good, even a refunded
// one. Named after the account instead, the cookie follows the run, which moved there too.
export const moveFreeRunCookie = (
    ctx: AuthCookieContext,
    anonymousUserId: string,
    userId: string,
    isSecure: boolean,
): void => {
    if (parseFreeRunUserId(ctx.headers?.get('cookie')) !== anonymousUserId) {
        return
    }

    ctx.setCookie(FREE_RUN_COOKIE, userId, toCookieOptions(isSecure, FREE_RUN_COOKIE_MAX_AGE_S))
}
