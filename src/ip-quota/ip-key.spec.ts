import { deriveIpKey, deriveRateLimitKey } from './ip-key'

describe('the rate-limit key', () => {
    it('is derived from the same secret under its own label, so it differs from the network key and the secret', () => {
        const key = deriveRateLimitKey('secret-a')

        expect(key.equals(deriveIpKey('secret-a'))).toBe(false)
        expect(key.equals(Buffer.from('secret-a'))).toBe(false)
    })
})
