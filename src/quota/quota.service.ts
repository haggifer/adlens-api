import { HttpStatus, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectConnection } from '@nestjs/mongoose'
import { type Quota, QUOTA_WINDOW_MS, RequestErrorCode } from 'adlens-shared'
import { type Connection, Types } from 'mongoose'
import { ApiException } from '../common/api-exception'
import { countedRuns } from '../common/counted-runs'
import {
    getUserAccess,
    isProvisional,
    readUserAccess,
    toProvisionalRefusal,
    USER_ACCESS_PROJECTION,
    UserAccess,
} from '../common/user-access'
import type { Env } from '../config/env'
import { type QuotaRun, USER_COLLECTION, type UserExtras } from '../database/user.doc'

// What an anonymous user or an unconfirmed account gets before it must sign up or confirm its email. Clearing cookies
// gets a new anonymous user, so the network's anonymous allowance (IP_ANON_LIMIT) remains the real bound.
export const PROVISIONAL_QUOTA_LIMIT = 1

// getUserAccess in a pipeline expression, for an account that isn't an admin.
const IS_PROVISIONAL_EXPR = { $or: [{ $eq: ['$isAnonymous', true] }, { $ne: ['$emailVerified', true] }] }

export const toQuotaRefusal = (access: UserAccess): ApiException =>
    isProvisional(access)
        ? toProvisionalRefusal(access)
        : new ApiException(HttpStatus.TOO_MANY_REQUESTS, RequestErrorCode.QuotaExceeded, 'Analysis limit reached')

@Injectable()
export class QuotaService {
    private readonly limit: number

    constructor(
        @InjectConnection() private readonly connection: Connection,
        config: ConfigService<Env, true>,
    ) {
        this.limit = config.get('QUOTA_LIMIT', { infer: true })
    }

    private get users() {
        return this.connection.collection<UserExtras>(USER_COLLECTION)
    }

    // Charges one run for the job and returns the run's id: the one the job recorded before charging, when given. One
    // conditional update on the user's document counts the runs of the last window, drops older ones and appends the
    // new run, so concurrent calls can't overdraw. An admin's charge always matches: their runs are counted but never
    // capped. Anonymous users and unconfirmed accounts get PROVISIONAL_QUOTA_LIMIT, read from the same document.
    async consume(
        userId: string,
        jobId: string,
        now = new Date(),
        runId = new Types.ObjectId().toString(),
    ): Promise<string> {
        const cutoff = new Date(now.getTime() - QUOTA_WINDOW_MS)
        const run: QuotaRun = { id: runId, startedAt: now, jobId }
        const charged = await this.users.findOneAndUpdate(
            {
                _id: new Types.ObjectId(userId),
                $expr: {
                    $or: [
                        { $eq: ['$isAdmin', true] },
                        {
                            $lt: [
                                { $size: countedRuns(cutoff) },
                                { $cond: [IS_PROVISIONAL_EXPR, PROVISIONAL_QUOTA_LIMIT, this.limit] },
                            ],
                        },
                    ],
                },
            },
            [{ $set: { runs: { $concatArrays: [countedRuns(cutoff), { $literal: [run] }] } } }],
        )

        if (!charged) {
            const access = await readUserAccess(this.connection, userId)

            throw toQuotaRefusal(access)
        }

        return run.id
    }

    // A run that has already left the window is no longer stored, so refunding it changes nothing.
    async refund(userId: string, runId: string): Promise<void> {
        await this.users.updateOne({ _id: new Types.ObjectId(userId) }, { $pull: { runs: { id: runId } } })
    }

    // Moves an anonymous user's runs onto the account they signed up or in with, so signing up never resets the
    // quota. $addToSet keeps a retried move from counting a run twice.
    async transfer(fromUserId: string, toUserId: string): Promise<void> {
        const from = await this.users.findOne({ _id: new Types.ObjectId(fromUserId) }, { projection: { runs: 1 } })
        const runs = from?.runs ?? []

        if (!runs.length) {
            return
        }

        await this.users.updateOne({ _id: new Types.ObjectId(toUserId) }, { $addToSet: { runs: { $each: runs } } })
    }

    async get(userId: string, now = new Date()): Promise<Quota> {
        const cutoff = now.getTime() - QUOTA_WINDOW_MS
        const user = await this.users.findOne(
            { _id: new Types.ObjectId(userId) },
            { projection: { ...USER_ACCESS_PROJECTION, runs: 1 } },
        )
        const starts = (user?.runs ?? []).map((run) => run.startedAt.getTime()).filter((start) => start > cutoff)
        const oldest = starts.length ? Math.min(...starts) : null

        return {
            used: starts.length,
            limit: this.getLimit(getUserAccess(user)),
            nextFreeAt: oldest === null ? null : new Date(oldest + QUOTA_WINDOW_MS).toISOString(),
        }
    }

    private getLimit(access: UserAccess): number | null {
        if (access === UserAccess.Admin) {
            return null
        }

        return isProvisional(access) ? PROVISIONAL_QUOTA_LIMIT : this.limit
    }
}
