import { db } from '@/infra/firebase'
import { AppError } from '@/infra/errors'
import { quotaDoc } from '@/utils/paths'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_LIMIT = 3

// The only place a run is counted. Rules can't do time-window counting and the
// doc is write-never for clients, so quota is unspoofable.
export const consumeQuota = async (uid: string): Promise<void> => {
    await db.runTransaction(async (tx) => {
        const ref = db.doc(quotaDoc(uid))
        const snap = await tx.get(ref)
        const data = snap.data() ?? {}
        const now = Date.now()

        let used = typeof data.used === 'number' ? data.used : 0
        let windowStart = typeof data.windowStart === 'number' ? data.windowStart : 0
        const limit = typeof data.limit === 'number' ? data.limit : DEFAULT_LIMIT

        if (now - windowStart >= WEEK_MS) {
            used = 0
            windowStart = now
        }

        if (used >= limit) {
            throw new AppError(429, 'Weekly limit reached', 'quota_exhausted')
        }

        tx.set(ref, { used: used + 1, windowStart, limit }, { merge: true })
    })
}
