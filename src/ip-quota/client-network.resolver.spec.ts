import { configStub } from '../testing/config-stub'
import { ClientNetworkResolver } from './client-network.resolver'

const SECRET = 'resolver-test-secret-resolver-test-secret'

describe('ClientNetworkResolver', () => {
    const resolver = new ClientNetworkResolver(configStub({ BETTER_AUTH_SECRET: SECRET, TRUSTED_PROXY_HOPS: 1 }))

    it('keys every address in one IPv6 /64 alike, and different networks apart', () => {
        const first = resolver.resolve({ forwardedFor: '2001:db8:1:2::1', socketAddress: undefined })
        const second = resolver.resolve({
            forwardedFor: '198.51.100.1, 2001:db8:1:2:ffff::9',
            socketAddress: undefined,
        })
        const other = resolver.resolve({ forwardedFor: '2001:db8:1:3::1', socketAddress: undefined })

        expect(second.bucketKey).toBe(first.bucketKey)
        expect(other.bucketKey).not.toBe(first.bucketKey)
    })

    it('keeps the address for the Turnstile check but never puts it in the key', () => {
        const network = resolver.resolve({ forwardedFor: undefined, socketAddress: '::ffff:203.0.113.7' })

        expect(network.ip).toBe('::ffff:203.0.113.7')
        expect(network.bucketKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(network.bucketKey).not.toContain('203.0.113.7')
    })

    it('refuses to start without the secret the key is derived from', () => {
        expect(() => new ClientNetworkResolver(configStub({ TRUSTED_PROXY_HOPS: 1 }))).toThrow('BETTER_AUTH_SECRET')
    })
})
