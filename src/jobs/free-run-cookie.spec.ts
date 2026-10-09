import type { Request, Response } from 'express'
import { FREE_RUN_COOKIE, moveFreeRunCookie, readFreeRunUserId, writeFreeRunCookie } from './free-run-cookie'

const requestWith = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } }) as Request

const authContextWith = (cookie: string) => ({ headers: new Headers({ cookie }), setCookie: jest.fn() })

describe('free run cookie', () => {
    it('reads the user that last ran an analysis in the browser among other cookies', () => {
        expect(readFreeRunUserId(requestWith(`a=1; ${FREE_RUN_COOKIE}=user-1; b=2`))).toBe('user-1')
    })

    it('reads nothing without the cookie, or with an empty one', () => {
        expect(readFreeRunUserId(requestWith())).toBeNull()
        expect(readFreeRunUserId(requestWith('other=1'))).toBeNull()
        expect(readFreeRunUserId(requestWith(`${FREE_RUN_COOKIE}=`))).toBeNull()
    })

    it('reads a value that is not valid percent-encoding as no cookie', () => {
        expect(readFreeRunUserId(requestWith(`${FREE_RUN_COOKIE}=%E0%A4%A`))).toBeNull()
    })

    it('keeps it from scripts for 400 days, secure over HTTPS', () => {
        const cookie = jest.fn()

        writeFreeRunCookie({ cookie } as unknown as Response, 'user-1', true)

        expect(cookie).toHaveBeenCalledWith(FREE_RUN_COOKIE, 'user-1', {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            path: '/',
            maxAge: 400 * 24 * 60 * 60 * 1000,
        })
    })

    it('names the account instead when an anonymous user that ran in the browser links to it, for 400 more days', () => {
        const ctx = authContextWith(`a=1; ${FREE_RUN_COOKIE}=anonymous-1`)

        moveFreeRunCookie(ctx, 'anonymous-1', 'account-1', true)

        expect(ctx.setCookie).toHaveBeenCalledWith(FREE_RUN_COOKIE, 'account-1', {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            path: '/',
            maxAge: 400 * 24 * 60 * 60,
        })
    })

    it('leaves a cookie naming someone else, or none, as it is when linking', () => {
        const other = authContextWith(`${FREE_RUN_COOKIE}=someone-else`)
        const none = authContextWith('a=1')

        moveFreeRunCookie(other, 'anonymous-1', 'account-1', true)
        moveFreeRunCookie(none, 'anonymous-1', 'account-1', true)

        expect(other.setCookie).not.toHaveBeenCalled()
        expect(none.setCookie).not.toHaveBeenCalled()
    })
})
