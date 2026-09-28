import { checkIpRules, IpVerdict } from './ip-rules'

const LIMITS = { anonymous: 3, soft: 10, hard: 30 }

describe('checkIpRules', () => {
    it('lets a signed-in user under the soft limit through without a challenge', () => {
        expect(checkIpRules({ total: 9, anonymous: 2 }, false, LIMITS)).toBe(IpVerdict.Allowed)
    })

    it('always asks an anonymous user for a challenge, and everyone from the soft limit on', () => {
        expect(checkIpRules({ total: 0, anonymous: 0 }, true, LIMITS)).toBe(IpVerdict.NeedsChallenge)
        expect(checkIpRules({ total: 10, anonymous: 0 }, false, LIMITS)).toBe(IpVerdict.NeedsChallenge)
    })

    it('sends anonymous users to sign up once the network used its anonymous analyses', () => {
        expect(checkIpRules({ total: 3, anonymous: 3 }, true, LIMITS)).toBe(IpVerdict.SignUpRequired)
        expect(checkIpRules({ total: 3, anonymous: 3 }, false, LIMITS)).toBe(IpVerdict.Allowed)
    })

    it('stops everyone at the hard limit before any other rule', () => {
        expect(checkIpRules({ total: 30, anonymous: 3 }, true, LIMITS)).toBe(IpVerdict.NetworkLimit)
        expect(checkIpRules({ total: 30, anonymous: 0 }, false, LIMITS)).toBe(IpVerdict.NetworkLimit)
    })
})
