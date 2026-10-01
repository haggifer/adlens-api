import { RequestErrorCode } from 'adlens-shared'
import { UserAccess } from '../common/user-access'
import { checkIpRules, IpVerdict, toIpRefusal } from './ip-rules'

const LIMITS = { anonymous: 3, soft: 10, hard: 30 }

describe('checkIpRules', () => {
    it('lets a member under the soft limit through without a challenge', () => {
        expect(checkIpRules({ total: 9, anonymous: 2 }, UserAccess.Member, LIMITS)).toBe(IpVerdict.Allowed)
    })

    it('always asks anonymous users and unconfirmed accounts for a challenge, and everyone from the soft limit on', () => {
        expect(checkIpRules({ total: 0, anonymous: 0 }, UserAccess.Anonymous, LIMITS)).toBe(IpVerdict.NeedsChallenge)
        expect(checkIpRules({ total: 0, anonymous: 0 }, UserAccess.Unconfirmed, LIMITS)).toBe(IpVerdict.NeedsChallenge)
        expect(checkIpRules({ total: 10, anonymous: 0 }, UserAccess.Member, LIMITS)).toBe(IpVerdict.NeedsChallenge)
    })

    it('stops anonymous users and unconfirmed accounts once the network used its anonymous analyses', () => {
        expect(checkIpRules({ total: 2, anonymous: 2 }, UserAccess.Anonymous, LIMITS)).toBe(IpVerdict.NeedsChallenge)
        expect(checkIpRules({ total: 3, anonymous: 3 }, UserAccess.Anonymous, LIMITS)).toBe(IpVerdict.AnonymousLimit)
        expect(checkIpRules({ total: 3, anonymous: 3 }, UserAccess.Unconfirmed, LIMITS)).toBe(IpVerdict.AnonymousLimit)
        expect(checkIpRules({ total: 3, anonymous: 3 }, UserAccess.Member, LIMITS)).toBe(IpVerdict.Allowed)
    })

    it('stops everyone at the hard limit before any other rule', () => {
        expect(checkIpRules({ total: 29, anonymous: 0 }, UserAccess.Member, LIMITS)).toBe(IpVerdict.NeedsChallenge)
        expect(checkIpRules({ total: 30, anonymous: 3 }, UserAccess.Anonymous, LIMITS)).toBe(IpVerdict.NetworkLimit)
        expect(checkIpRules({ total: 30, anonymous: 0 }, UserAccess.Member, LIMITS)).toBe(IpVerdict.NetworkLimit)
    })
})

describe('toIpRefusal', () => {
    it('asks an anonymous user to sign up, and an unconfirmed account to confirm its email, at the anonymous limit', () => {
        expect(toIpRefusal(IpVerdict.AnonymousLimit, UserAccess.Anonymous)).toMatchObject({
            response: { errorCode: RequestErrorCode.SignUpRequired },
        })
        expect(toIpRefusal(IpVerdict.AnonymousLimit, UserAccess.Unconfirmed)).toMatchObject({
            response: { errorCode: RequestErrorCode.EmailConfirmationRequired },
        })
    })

    it('answers the network limit and the challenge the same for everyone', () => {
        expect(toIpRefusal(IpVerdict.NetworkLimit, UserAccess.Unconfirmed)).toMatchObject({
            response: { errorCode: RequestErrorCode.NetworkQuotaExceeded },
        })
        expect(toIpRefusal(IpVerdict.NeedsChallenge, UserAccess.Unconfirmed)).toMatchObject({
            response: { errorCode: RequestErrorCode.ChallengeRequired },
        })
    })
})
