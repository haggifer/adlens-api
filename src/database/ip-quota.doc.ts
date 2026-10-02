import { z } from 'zod'
import { zodToMongoose } from '../common/zod-to-mongoose'

export const IP_QUOTA_MODEL = 'IpQuota'
export const IP_QUOTA_COLLECTION = 'ip_quotas'

// One document per network, keyed by an HMAC of it (ClientNetworkResolver), so the address is never stored. It holds
// only the runs still inside the window, and MongoDB deletes it a window after its last charge.
export const ipQuotaDocSchema = z.object({
    _id: z.string(),
    runs: z.array(
        z.object({
            id: z.string(),
            startedAt: z.date(),
            jobId: z.string(),
            // Counted against the network's anonymous allowance: an anonymous user's or an unconfirmed account's.
            anonymous: z.boolean(),
        }),
    ),
    expiresAt: z.date(),
})

export type IpQuotaDoc = z.infer<typeof ipQuotaDocSchema>
export type IpRun = IpQuotaDoc['runs'][number]

export const IpQuotaSchema = zodToMongoose(ipQuotaDocSchema, { collection: IP_QUOTA_COLLECTION })
IpQuotaSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
// Refunds find a run by its id alone: the worker refunds failed runs and holds no network key.
IpQuotaSchema.index({ 'runs.id': 1 })
