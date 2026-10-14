import { assertAuthProxyHops } from './auth-proxies'

describe('assertAuthProxyHops', () => {
    it('accepts the one hop Better Auth reads the client address with', () => {
        expect(() => assertAuthProxyHops(1)).not.toThrow()
    })

    it('refuses another proxy until Better Auth is told about it', () => {
        expect(() => assertAuthProxyHops(2)).toThrow(/TRUSTED_PROXY_HOPS is 2/)
    })
})
