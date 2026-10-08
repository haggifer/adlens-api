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

// What a user gets before confirming an email, in total: an anonymous user and the account it signs up with share it
// (freeRunId moves with the runs), and it never comes back with the window. Clearing cookies gets a new anonymous user,
// so the network's anonymous allowance (IP_ANON_LIMIT) remains the real bound.
const PROVISIONAL_QUOTA_LIMIT = 1

// getUserAccess in a pipeline expression, for an account that isn't an admin.
const IS_PROVISIONAL_EXPR = { $or: [{ $eq: ['$isAnonymous', true] }, { $ne: ['$emailVerified', true] }] }

const HAS_FREE_RUN_EXPR = { $ne: [{ $ifNull: ['$freeRunId', null] }, null] }

const USER_QUOTA_PROJECTION = { ...USER_ACCESS_PROJECTION, runs: 1, freeRunId: 1 }

type QuotaFields = Pick<UserExtras, 'isAdmin' | 'isAnonymous' | 'emailVerified' | 'runs' | 'freeRunId'>

const countRunsSince = (user: QuotaFields | null, cutoff: number): number =>
    (user?.runs ?? []).filter((run) => run.startedAt.getTime() > cutoff).length

const toQuotaRefusal = (access: UserAccess): ApiException =>
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
        const charged = await this.appendRun(userId, run, cutoff)

        if (!charged) {
            const access = await readUserAccess(this.connection, userId)

            throw toQuotaRefusal(access)
        }

        return run.id
    }

    // A run that has already left the window is no longer stored, so refunding it changes nothing.
    async refund(userId: string, runId: string): Promise<void> {
        const _id = new Types.ObjectId(userId)

        await this.users.updateOne({ _id }, { $pull: { runs: { id: runId } } })
        await this.users.updateOne({ _id, freeRunId: runId }, { $set: { freeRunId: null } })
    }

    // Moves an anonymous user's runs onto the account they signed up or in with, so signing up never resets the
    // quota, and its used free analysis with them. $addToSet keeps a retried move from counting a run twice.
    async transfer(fromUserId: string, toUserId: string): Promise<void> {
        const from = await this.users.findOne(
            { _id: new Types.ObjectId(fromUserId) },
            { projection: { runs: 1, freeRunId: 1 } },
        )
        const runs = from?.runs ?? []
        const to = new Types.ObjectId(toUserId)

        if (runs.length) {
            await this.users.updateOne({ _id: to }, { $addToSet: { runs: { $each: runs } } })
        }

        if (from?.freeRunId) {
            await this.users.updateOne({ _id: to, freeRunId: null }, { $set: { freeRunId: from.freeRunId } })
        }
    }

    // Throws the refusal a charge would meet now, so nobody uploads a video only to be refused at analyze; otherwise
    // returns the user's access.
    async check(userId: string, now = new Date()): Promise<UserAccess> {
        const user = await this.users.findOne(
            { _id: new Types.ObjectId(userId) },
            { projection: USER_QUOTA_PROJECTION },
        )
        const access = getUserAccess(user)
        const used = countRunsSince(user, now.getTime() - QUOTA_WINDOW_MS)

        if (access === UserAccess.Admin) {
            return access
        }

        const hasRunLeft = isProvisional(access)
            ? !user?.freeRunId && used < PROVISIONAL_QUOTA_LIMIT
            : used < this.limit

        if (!hasRunLeft) {
            throw toQuotaRefusal(access)
        }

        return access
    }

    async get(userId: string, now = new Date()): Promise<Quota> {
        const cutoff = now.getTime() - QUOTA_WINDOW_MS
        const user = await this.users.findOne(
            { _id: new Types.ObjectId(userId) },
            { projection: USER_QUOTA_PROJECTION },
        )
        const starts = (user?.runs ?? []).map((run) => run.startedAt.getTime()).filter((start) => start > cutoff)
        const oldest = starts.length ? Math.min(...starts) : null

        return {
            used: starts.length,
            limit: this.getLimit(getUserAccess(user)),
            nextFreeAt: oldest === null ? null : new Date(oldest + QUOTA_WINDOW_MS).toISOString(),
        }
    }

    // A provisional user's charge records its run as the free one, in the same update.
    private appendRun(userId: string, run: QuotaRun, cutoff: Date) {
        const isFreeRun = { $and: [{ $ne: ['$isAdmin', true] }, IS_PROVISIONAL_EXPR] }

        return this.users.findOneAndUpdate({ _id: new Types.ObjectId(userId), $expr: this.admits(cutoff) }, [
            {
                $set: {
                    runs: { $concatArrays: [countedRuns(cutoff), { $literal: [run] }] },
                    freeRunId: { $cond: [isFreeRun, run.id, { $ifNull: ['$freeRunId', null] }] },
                },
            },
        ])
    }

    private admits(cutoff: Date): object {
        const used = { $size: countedRuns(cutoff) }

        return {
            $or: [
                { $eq: ['$isAdmin', true] },
                {
                    $cond: [
                        IS_PROVISIONAL_EXPR,
                        { $and: [{ $not: [HAS_FREE_RUN_EXPR] }, { $lt: [used, PROVISIONAL_QUOTA_LIMIT] }] },
                        { $lt: [used, this.limit] },
                    ],
                },
            ],
        }
    }

    // Everyone but an admin sees the weekly allowance; a provisional user's one analysis is enforced by the charge.
    private getLimit(access: UserAccess): number | null {
        return access === UserAccess.Admin ? null : this.limit
    }
}
