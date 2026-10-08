import type { Request, Response } from 'express'

// A browser gets one analysis before an email is confirmed, whoever runs it. Signing in moves the anonymous user that
// used it to the account and deletes it, so after signing out a new anonymous session (or a new unconfirmed account)
// would get another; this cookie remembers who last ran an analysis in the browser. Clearing cookies gets around it,
// which the network's anonymous allowance still bounds.
export const FREE_RUN_COOKIE = 'adlens_free_run'

// For good, as far as browsers allow: Chrome caps a cookie's lifetime at 400 days.
const FREE_RUN_COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000

export const readFreeRunUserId = (req: Request): string | null => {
    const prefix = `${FREE_RUN_COOKIE}=`
    const pair = (req.headers.cookie ?? '')
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(prefix))

    return pair ? decodeURIComponent(pair.slice(prefix.length)) || null : null
}

// Host-only on the API, which alone reads it.
export const writeFreeRunCookie = (res: Response, userId: string, isSecure: boolean): void => {
    res.cookie(FREE_RUN_COOKIE, userId, {
        httpOnly: true,
        secure: isSecure,
        sameSite: 'lax',
        path: '/',
        maxAge: FREE_RUN_COOKIE_MAX_AGE_MS,
    })
}
