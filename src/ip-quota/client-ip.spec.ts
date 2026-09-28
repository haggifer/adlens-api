import { countForwardedEntries, ipBucket, pickClientIp } from './client-ip'

describe('pickClientIp', () => {
    it('takes the socket address when no proxy forwarded the request', () => {
        expect(pickClientIp({ forwardedFor: undefined, socketAddress: '::ffff:127.0.0.1' }, 1)).toBe('::ffff:127.0.0.1')
    })

    it('takes the entry our own front end appended, never what the client sent before it', () => {
        expect(pickClientIp({ forwardedFor: '203.0.113.7', socketAddress: '10.0.0.1' }, 1)).toBe('203.0.113.7')
        expect(pickClientIp({ forwardedFor: '198.51.100.1, 203.0.113.7', socketAddress: '10.0.0.1' }, 1)).toBe(
            '203.0.113.7',
        )
    })

    it('skips one entry from the right per trusted proxy', () => {
        expect(pickClientIp({ forwardedFor: '198.51.100.1, 203.0.113.7, 10.1.1.1', socketAddress: undefined }, 2)).toBe(
            '203.0.113.7',
        )
    })

    it('reads a header repeated across lines as one list', () => {
        expect(
            pickClientIp(
                { forwardedFor: ['198.51.100.1, 198.51.100.2', ' 203.0.113.7 '], socketAddress: undefined },
                1,
            ),
        ).toBe('203.0.113.7')
    })

    it('takes the leftmost entry when there are fewer entries than proxies', () => {
        expect(pickClientIp({ forwardedFor: '203.0.113.7', socketAddress: undefined }, 2)).toBe('203.0.113.7')
    })

    it('has no address when neither the header nor the socket has one', () => {
        expect(pickClientIp({ forwardedFor: '', socketAddress: undefined }, 1)).toBeNull()
    })
})

describe('countForwardedEntries', () => {
    it('counts the entries without reading them', () => {
        expect(countForwardedEntries(' 198.51.100.1 , 203.0.113.7 ')).toBe(2)
        expect(countForwardedEntries(undefined)).toBe(0)
    })
})

describe('ipBucket', () => {
    it('keeps an IPv4 address as it is', () => {
        expect(ipBucket('203.0.113.7')).toBe('203.0.113.7')
    })

    it('groups an IPv6 address by its /64 prefix', () => {
        expect(ipBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64')
        expect(ipBucket('2001:0DB8:0001:0002::1')).toBe('2001:db8:1:2::/64')
        expect(ipBucket('2001:db8::1')).toBe('2001:db8:0:0::/64')
        expect(ipBucket('64:ff9b::192.0.2.33')).toBe('64:ff9b:0:0::/64')
    })

    it('counts an IPv4-mapped IPv6 address as the IPv4 address', () => {
        expect(ipBucket('::ffff:203.0.113.7')).toBe('203.0.113.7')
        expect(ipBucket('::FFFF:203.0.113.7')).toBe('203.0.113.7')
    })

    it('ignores an IPv6 zone', () => {
        expect(ipBucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
    })

    it('rejects anything that is not an address', () => {
        expect(ipBucket('not-an-ip')).toBeNull()
        expect(ipBucket('')).toBeNull()
    })
})
