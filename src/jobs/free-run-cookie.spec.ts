import type { Request, Response } from 'express'
import { FREE_RUN_COOKIE, readFreeRunUserId, writeFreeRunCookie } from './free-run-cookie'

const requestWith = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } }) as Request

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
})
