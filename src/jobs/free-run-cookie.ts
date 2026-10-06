import { QUOTA_WINDOW_MS } from 'adlens-shared'
import type { Request, Response } from 'express'

// A browser gets one free analysis without an account. Signing in moves the anonymous user that used it to the account
// and deletes it, so after signing out a new anonymous session would get another; this cookie remembers which
// anonymous user used it. Clearing cookies gets around it, which the network's anonymous allowance still bounds.
export const FREE_RUN_COOKIE = 'adlens_free_run'

export const readFreeRunUserId = (req: Request): string | null => {
    const prefix = `${FREE_RUN_COOKIE}=`
    const pair = (req.headers.cookie ?? '')
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(prefix))

    return pair ? decodeURIComponent(pair.slice(prefix.length)) || null : null
}

// Host-only on the API, which alone reads it; it lasts as long as the quota window an anonymous user's analysis counts in.
export const writeFreeRunCookie = (res: Response, userId: string, isSecure: boolean): void => {
    res.cookie(FREE_RUN_COOKIE, userId, {
        httpOnly: true,
        secure: isSecure,
        sameSite: 'lax',
        path: '/',
        maxAge: QUOTA_WINDOW_MS,
    })
}
