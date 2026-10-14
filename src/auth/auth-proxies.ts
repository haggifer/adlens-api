// Without trusted proxies Better Auth trusts X-Forwarded-For only with a single entry, and puts every other request in
// one shared rate-limit bucket. With any list it walks the header from the right and takes the first entry not in it;
// loopback is never a client behind Cloud Run, so that is the rightmost entry.
export const AUTH_TRUSTED_PROXIES = ['127.0.0.1/32']

// The rightmost entry is the address ClientNetworkResolver takes only with one proxy hop. Behind another proxy (a load
// balancer, a CDN), Better Auth would key every visitor on that proxy's address, so it must be given the proxy's
// ranges instead; until it is, the API refuses to start rather than share one bucket between all visitors.
export const assertAuthProxyHops = (trustedProxyHops: number): void => {
    if (trustedProxyHops !== 1) {
        throw new Error(
            `TRUSTED_PROXY_HOPS is ${trustedProxyHops}: set Better Auth's trustedProxies (src/auth/auth-proxies.ts) to the extra proxies' ranges first`,
        )
    }
}
