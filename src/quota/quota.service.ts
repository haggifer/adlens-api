import { HttpStatus, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectConnection } from '@nestjs/mongoose'
import { type Quota, QUOTA_WINDOW_MS, RequestErrorCode } from 'adlens-shared'
import { type Connection, Types } from 'mongoose'
import { ApiException } from '../common/api-exception'
import { countedRuns } from '../common/counted-runs'
import type { Env } from '../config/env'
import { type QuotaRun, USER_COLLECTION, type UserExtras } from '../database/user.doc'

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

    // Charges one run for the job and returns the run's id. One conditional update on the user's document counts the
    // runs of the last window, drops older ones and appends the new run, so concurrent calls can't overdraw. An
    // admin's charge always matches: their runs are counted but never capped.
    async consume(userId: string, jobId: string, now = new Date()): Promise<string> {
        const cutoff = new Date(now.getTime() - QUOTA_WINDOW_MS)
        const run: QuotaRun = { id: new Types.ObjectId().toString(), startedAt: now, jobId }
        const charged = await this.users.findOneAndUpdate(
            {
                _id: new Types.ObjectId(userId),
                $expr: { $or: [{ $eq: ['$isAdmin', true] }, { $lt: [{ $size: countedRuns(cutoff) }, this.limit] }] },
            },
            [{ $set: { runs: { $concatArrays: [countedRuns(cutoff), { $literal: [run] }] } } }],
        )

        if (!charged) {
            throw new ApiException(
                HttpStatus.TOO_MANY_REQUESTS,
                RequestErrorCode.QuotaExceeded,
                'Analysis limit reached',
            )
        }

        return run.id
    }

    // A run that has already left the window is no longer stored, so refunding it changes nothing.
    async refund(userId: string, runId: string): Promise<void> {
        await this.users.updateOne({ _id: new Types.ObjectId(userId) }, { $pull: { runs: { id: runId } } })
    }

    async get(userId: string, now = new Date()): Promise<Quota> {
        const cutoff = now.getTime() - QUOTA_WINDOW_MS
        const user = await this.users.findOne(
            { _id: new Types.ObjectId(userId) },
            { projection: { isAdmin: 1, runs: 1 } },
        )
        const starts = (user?.runs ?? []).map((run) => run.startedAt.getTime()).filter((start) => start > cutoff)
        const oldest = starts.length ? Math.min(...starts) : null

        return {
            used: starts.length,
            limit: user?.isAdmin ? null : this.limit,
            nextFreeAt: oldest === null ? null : new Date(oldest + QUOTA_WINDOW_MS).toISOString(),
        }
    }
}
