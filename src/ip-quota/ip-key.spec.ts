import { deriveIpKey, deriveRateLimitKey, hashBucket } from './ip-key'

describe('the network key', () => {
    it('is derived from the secret, stable, and not the secret itself', () => {
        const key = deriveIpKey('secret-a')

        expect(key).toHaveLength(32)
        expect(key.equals(deriveIpKey('secret-a'))).toBe(true)
        expect(key.equals(Buffer.from('secret-a'))).toBe(false)
    })

    it('hashes a network the same way every time, and differently under another secret', () => {
        const key = deriveIpKey('secret-a')

        expect(hashBucket(key, '203.0.113.7')).toBe(hashBucket(key, '203.0.113.7'))
        expect(hashBucket(key, '203.0.113.7')).not.toBe(hashBucket(deriveIpKey('secret-b'), '203.0.113.7'))
    })

    it('never contains the address it hashes', () => {
        expect(hashBucket(deriveIpKey('secret-a'), '203.0.113.7')).not.toContain('203.0.113')
    })
})

describe('the rate-limit key', () => {
    it('is derived from the same secret under its own label, so it differs from the network key', () => {
        expect(deriveRateLimitKey('secret-a')).toHaveLength(32)
        expect(deriveRateLimitKey('secret-a').equals(deriveIpKey('secret-a'))).toBe(false)
    })
})
