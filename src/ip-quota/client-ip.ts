import { isIPv4, isIPv6 } from 'node:net'

export interface IpSource {
    forwardedFor: string | string[] | undefined
    socketAddress: string | undefined
}

const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i
const IPV6_HEXTETS = 8
const IPV6_PREFIX_HEXTETS = 4

const forwardedEntries = (header: string | string[] | undefined): string[] =>
    (Array.isArray(header) ? header.join(',') : (header ?? ''))
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)

export const countForwardedEntries = (header: string | string[] | undefined): number => forwardedEntries(header).length

// Every proxy appends the address it saw, so the entry `trustedHops` from the right is the one our own front end wrote;
// everything left of it is whatever the client sent. Without the header (local development), the socket's address.
export const pickClientIp = ({ forwardedFor, socketAddress }: IpSource, trustedHops: number): string | null => {
    const entries = forwardedEntries(forwardedFor)

    if (!entries.length) {
        return socketAddress ?? null
    }

    return entries[Math.max(entries.length - trustedHops, 0)]
}

// An embedded IPv4 tail (a.b.c.d) fills two hextets.
const hextetWidth = (part: string) => (part.includes('.') ? 2 : 1)

const expandIpv6 = (address: string): string[] => {
    const [head, tail] = address.split('::')
    const headParts = head ? head.split(':') : []
    const tailParts = tail ? tail.split(':') : []
    const width = [...headParts, ...tailParts].reduce((sum, part) => sum + hextetWidth(part), 0)

    return [...headParts, ...Array<string>(IPV6_HEXTETS - width).fill('0'), ...tailParts]
}

// What a limit applies to: an IPv4 address, or an IPv6 /64, because a host can pick any address in its /64 for free.
// An IPv4-mapped IPv6 address is the IPv4 address, so a dual-stack visitor is one network.
export const ipBucket = (ip: string): string | null => {
    const address = ip.split('%')[0]
    const mapped = MAPPED_IPV4.exec(address)

    if (mapped) {
        return mapped[1]
    }

    if (isIPv4(address)) {
        return address
    }

    if (!isIPv6(address)) {
        return null
    }

    const prefix = expandIpv6(address)
        .slice(0, IPV6_PREFIX_HEXTETS)
        .map((hextet) => parseInt(hextet, 16).toString(16))

    return `${prefix.join(':')}::/64`
}
