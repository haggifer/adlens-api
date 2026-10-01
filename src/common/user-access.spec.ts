import { HttpStatus } from '@nestjs/common'
import { RequestErrorCode } from 'adlens-shared'
import { getUserAccess, isProvisional, toProvisionalRefusal, UserAccess } from './user-access'

describe('getUserAccess', () => {
    it('reads an admin first, whatever else the document says', () => {
        expect(getUserAccess({ isAdmin: true, emailVerified: false })).toBe(UserAccess.Admin)
    })

    it('reads an anonymous user', () => {
        expect(getUserAccess({ isAnonymous: true, emailVerified: false })).toBe(UserAccess.Anonymous)
    })

    it('reads an account that has not confirmed its email, or whose document says nothing, as unconfirmed', () => {
        expect(getUserAccess({ isAnonymous: false, emailVerified: false })).toBe(UserAccess.Unconfirmed)
        expect(getUserAccess({})).toBe(UserAccess.Unconfirmed)
        expect(getUserAccess(null)).toBe(UserAccess.Unconfirmed)
    })

    it('reads a confirmed account as a member', () => {
        expect(getUserAccess({ isAnonymous: false, emailVerified: true })).toBe(UserAccess.Member)
    })
})

describe('isProvisional', () => {
    it('limits anonymous users and unconfirmed accounts alike, and nobody else', () => {
        expect(isProvisional(UserAccess.Anonymous)).toBe(true)
        expect(isProvisional(UserAccess.Unconfirmed)).toBe(true)
        expect(isProvisional(UserAccess.Member)).toBe(false)
        expect(isProvisional(UserAccess.Admin)).toBe(false)
    })
})

describe('toProvisionalRefusal', () => {
    it('asks an anonymous user to sign up and an unconfirmed account to confirm its email', () => {
        expect(toProvisionalRefusal(UserAccess.Anonymous)).toMatchObject({
            status: HttpStatus.TOO_MANY_REQUESTS,
            response: { errorCode: RequestErrorCode.SignUpRequired },
        })
        expect(toProvisionalRefusal(UserAccess.Unconfirmed)).toMatchObject({
            status: HttpStatus.TOO_MANY_REQUESTS,
            response: { errorCode: RequestErrorCode.EmailConfirmationRequired },
        })
    })
})
