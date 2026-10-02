import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Env } from '../config/env'
import { countForwardedEntries, ipBucket, type IpSource, pickClientIp } from './client-ip'
import { deriveIpKey, hashBucket } from './ip-key'

interface ClientNetwork {
    // Only passed to Turnstile's siteverify; never stored or logged.
    ip: string | null
    bucketKey: string
}

// Requests whose address can't be read share one network, so they are limited together rather than not at all.
const UNKNOWN_NETWORK = 'unknown'

// The key is derived from BETTER_AUTH_SECRET rather than a secret of its own; rotating that secret resets every
// network's count.
@Injectable()
export class ClientNetworkResolver {
    private readonly logger = new Logger(ClientNetworkResolver.name)
    private readonly key: Buffer
    private readonly trustedHops: number

    constructor(config: ConfigService<Env, true>) {
        const secret = config.get('BETTER_AUTH_SECRET', { infer: true })

        if (!secret) {
            throw new Error('BETTER_AUTH_SECRET is required: the network key is derived from it')
        }

        this.key = deriveIpKey(secret)
        this.trustedHops = config.get('TRUSTED_PROXY_HOPS', { infer: true })
    }

    resolve(source: IpSource): ClientNetwork {
        // The entry count, never an address: enough to confirm the header's shape in production logs.
        this.logger.log(`x-forwarded-for entries: ${countForwardedEntries(source.forwardedFor)}`)

        const ip = pickClientIp(source, this.trustedHops)
        const bucket = (ip && ipBucket(ip)) ?? UNKNOWN_NETWORK

        return { ip, bucketKey: hashBucket(this.key, bucket) }
    }
}
