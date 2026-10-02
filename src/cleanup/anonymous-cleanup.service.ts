import { Injectable, Logger } from '@nestjs/common'
import { InjectConnection } from '@nestjs/mongoose'
import type { Connection, Types } from 'mongoose'
import { AccountDataService } from '../account/account-data.service'
import { describeError } from '../common/error-message'
import { USER_COLLECTION, type UserExtras } from '../database/user.doc'
import type { CleanupResult } from './types'

// The privacy policy promises this: a week after the browser was last used, unless it signed up or in first.
export const ANONYMOUS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

// Better Auth's adapter may store a reference as an ObjectId or as its string form, so a lookup matches both.
const byUser = (_id: Types.ObjectId) => ({ userId: { $in: [_id, _id.toString()] } })

// Deletes anonymous users nobody can reach any more: once the browser's session has ended (it expired, or "Forget
// this browser" signed it out), nothing can link or show their analyses again.
@Injectable()
export class AnonymousCleanupService {
    private readonly logger = new Logger(AnonymousCleanupService.name)

    constructor(
        @InjectConnection() private readonly connection: Connection,
        private readonly accountData: AccountDataService,
    ) {}

    async run(now = new Date()): Promise<CleanupResult> {
        const cutoff = new Date(now.getTime() - ANONYMOUS_RETENTION_MS)
        const users = this.connection.collection<UserExtras>(USER_COLLECTION)
        const sessions = this.connection.collection('session')
        const accounts = this.connection.collection('account')
        const stale = this.findStaleUsers(cutoff)
        const result: CleanupResult = { deleted: 0, failed: 0 }

        for await (const { _id } of stale) {
            const userId = _id.toString()

            try {
                // lastSeenAt is written after the request, so a failed write could leave it behind a session that
                // is still in use.
                const liveSessions = await sessions.countDocuments({ ...byUser(_id), expiresAt: { $gt: now } })

                if (liveSessions > 0) {
                    continue
                }

                // The files and jobs go first: if that fails, the user stays and the next run tries again.
                await this.accountData.purge(userId)
                await sessions.deleteMany(byUser(_id))
                await accounts.deleteMany(byUser(_id))
                await users.deleteOne({ _id, isAnonymous: true })
                result.deleted++
            } catch (err) {
                result.failed++
                this.logger.error(`could not delete anonymous user ${userId}: ${describeError(err)}`)
            }
        }

        this.logger.log(`deleted ${result.deleted} anonymous users unused since ${cutoff.toISOString()}`)

        return result
    }

    private findStaleUsers(cutoff: Date) {
        return this.connection.collection<UserExtras>(USER_COLLECTION).find(
            {
                isAnonymous: true,
                $or: [{ lastSeenAt: { $lt: cutoff } }, { lastSeenAt: { $exists: false }, createdAt: { $lt: cutoff } }],
            },
            { projection: { _id: 1 } },
        )
    }
}
