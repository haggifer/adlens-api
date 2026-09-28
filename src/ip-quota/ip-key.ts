import { createHmac, hkdfSync } from 'node:crypto'

// A fixed label, so this key never equals another one derived from the same secret.
const IP_KEY_INFO = 'adlens/ip-quota/v1'
const KEY_BYTES = 32

export const deriveIpKey = (secret: string): Buffer =>
    Buffer.from(hkdfSync('sha256', secret, '', IP_KEY_INFO, KEY_BYTES))

export const hashBucket = (key: Buffer, bucket: string): string =>
    createHmac('sha256', key).update(bucket).digest('base64url')
