import { createHmac, hkdfSync } from 'node:crypto'

// Fixed labels, so no two keys derived from the same secret are ever equal.
const IP_KEY_INFO = 'adlens/ip-quota/v1'
const RATE_LIMIT_KEY_INFO = 'adlens/rate-limit/v1'
const KEY_BYTES = 32

const deriveKey = (secret: string, info: string): Buffer => Buffer.from(hkdfSync('sha256', secret, '', info, KEY_BYTES))

export const deriveIpKey = (secret: string): Buffer => deriveKey(secret, IP_KEY_INFO)

export const deriveRateLimitKey = (secret: string): Buffer => deriveKey(secret, RATE_LIMIT_KEY_INFO)

export const hashBucket = (key: Buffer, bucket: string): string =>
    createHmac('sha256', key).update(bucket).digest('base64url')
