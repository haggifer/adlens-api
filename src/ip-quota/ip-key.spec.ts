import { deriveIpKey, deriveRateLimitKey, hashBucket } from './ip-key'

describe('the network key', () => {
    it('hashes a network the same way every time, and differently under another secret', () => {
        const key = deriveIpKey('secret-a')

        expect(hashBucket(key, '203.0.113.7')).toBe(hashBucket(key, '203.0.113.7'))
        expect(hashBucket(key, '203.0.113.7')).not.toBe(hashBucket(deriveIpKey('secret-b'), '203.0.113.7'))
    })
})

describe('the rate-limit key', () => {
    it('is derived from the same secret under its own label, so it differs from the network key and the secret', () => {
        const key = deriveRateLimitKey('secret-a')

        expect(key.equals(deriveIpKey('secret-a'))).toBe(false)
        expect(key.equals(Buffer.from('secret-a'))).toBe(false)
    })
})
