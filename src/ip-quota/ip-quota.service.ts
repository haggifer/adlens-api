import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectConnection } from '@nestjs/mongoose'
import { QUOTA_WINDOW_MS } from 'adlens-shared'
import { type Connection, Types } from 'mongoose'
import { countedRuns } from '../common/counted-runs'
import type { Env } from '../config/env'
import { IP_QUOTA_COLLECTION, type IpQuotaDoc, type IpRun } from '../database/ip-quota.doc'
import { checkIpRules, type IpCharge, type IpLimits, type IpUsage, IpVerdict, toIpRefusal } from './ip-rules'

const DUPLICATE_KEY = 11000

const countedAnonymousRuns = (cutoff: Date) => ({
    $filter: { input: countedRuns(cutoff), cond: { $eq: ['$$this.anonymous', true] } },
})

const recentRefundedFailures = (cutoff: Date) => ({
    $filter: { input: { $ifNull: ['$refundedFailures', []] }, cond: { $gt: ['$$this', cutoff] } },
})

// The network side of the quota, with QuotaService's technique on one document per network. The limits come from
// config and are never stored.
@Injectable()
export class IpQuotaService {
    readonly limits: IpLimits
    private readonly failureRefundLimit: number

    constructor(
        @InjectConnection() private readonly connection: Connection,
        config: ConfigService<Env, true>,
    ) {
        this.limits = {
            anonymous: config.get('IP_ANON_LIMIT', { infer: true }),
            soft: config.get('IP_SOFT_LIMIT', { infer: true }),
            hard: config.get('IP_HARD_LIMIT', { infer: true }),
        }
        this.failureRefundLimit = config.get('IP_FAILURE_REFUND_LIMIT', { infer: true })
    }

    private get buckets() {
        return this.connection.collection<IpQuotaDoc>(IP_QUOTA_COLLECTION)
    }

    async usage(bucketKey: string, now = new Date()): Promise<IpUsage> {
        const cutoff = now.getTime() - QUOTA_WINDOW_MS
        const bucket = await this.buckets.findOne({ _id: bucketKey })
        const counted = (bucket?.runs ?? []).filter((run) => run.startedAt.getTime() > cutoff)

        return { total: counted.length, anonymous: counted.filter((run) => run.anonymous).length }
    }

    // Charges one run for the job and returns the run's id: the one the job recorded before charging, when given. One
    // conditional update counts the network's runs of the last window, drops older ones and appends the new run, so
    // concurrent calls can't overdraw.
    async charge(
        charge: IpCharge,
        jobId: string,
        now = new Date(),
        runId = new Types.ObjectId().toString(),
    ): Promise<string> {
        if (charge.isAnonymous && !charge.hasPassedChallenge) {
            throw toIpRefusal(IpVerdict.NeedsChallenge)
        }

        const cutoff = new Date(now.getTime() - QUOTA_WINDOW_MS)
        const expiresAt = new Date(now.getTime() + QUOTA_WINDOW_MS)
        const run: IpRun = { id: runId, startedAt: now, jobId, anonymous: charge.isAnonymous }

        await this.ensureBucket(charge.bucketKey, expiresAt)

        const charged = await this.buckets.findOneAndUpdate(
            { _id: charge.bucketKey, $expr: { $and: this.admits(charge, cutoff) } },
            [{ $set: { runs: { $concatArrays: [countedRuns(cutoff), { $literal: [run] }] }, expiresAt } }],
        )

        if (!charged) {
            const usage = await this.usage(charge.bucketKey, now)

            throw toIpRefusal(checkIpRules(usage, charge.isAnonymous, this.limits))
        }

        return run.id
    }

    // A run that has already left the window is no longer stored, so refunding it changes nothing.
    async refund(runId: string): Promise<void> {
        await this.buckets.updateOne({ 'runs.id': runId }, { $pull: { runs: { id: runId } } })
    }

    // Refunds the run of an analysis that failed after Gemini answered, unless the network already had its allowance
    // of such refunds this window; then the run stays counted, marked so that asking again gives the same answer. One
    // conditional update, so concurrent failures can't both take the last refund. Safe to repeat: true whenever the run
    // no longer counts (refunded now or earlier, or out of the window), false while it stays counted.
    async refundFailure(runId: string, now = new Date()): Promise<boolean> {
        const cutoff = new Date(now.getTime() - QUOTA_WINDOW_MS)
        const refunded = await this.buckets.updateOne(
            {
                runs: { $elemMatch: { id: runId, isRefundRefused: { $ne: true } } },
                $expr: { $lt: [{ $size: recentRefundedFailures(cutoff) }, this.failureRefundLimit] },
            },
            [
                {
                    $set: {
                        runs: { $filter: { input: '$runs', cond: { $ne: ['$$this.id', runId] } } },
                        refundedFailures: { $concatArrays: [recentRefundedFailures(cutoff), [now]] },
                    },
                },
            ],
        )

        if (refunded.modifiedCount > 0) {
            return true
        }

        const refused = await this.buckets.updateOne(
            { 'runs.id': runId },
            { $set: { 'runs.$[run].isRefundRefused': true } },
            { arrayFilters: [{ 'run.id': runId }] },
        )

        return refused.matchedCount === 0
    }

    private admits({ isAnonymous, hasPassedChallenge }: IpCharge, cutoff: Date): object[] {
        const conditions: object[] = [{ $lt: [{ $size: countedRuns(cutoff) }, this.limits.hard] }]

        if (isAnonymous) {
            conditions.push({ $lt: [{ $size: countedAnonymousRuns(cutoff) }, this.limits.anonymous] })
        }

        if (!hasPassedChallenge) {
            conditions.push({ $lt: [{ $size: countedRuns(cutoff) }, this.limits.soft] })
        }

        return conditions
    }

    // Concurrent first charges race to create the document; the loser's duplicate-key error only means it exists.
    // Pushing the expiry out here, never back, stops MongoDB deleting a nearly expired bucket before the charge lands.
    private async ensureBucket(bucketKey: string, expiresAt: Date): Promise<void> {
        try {
            await this.buckets.updateOne(
                { _id: bucketKey },
                { $setOnInsert: { runs: [] }, $max: { expiresAt } },
                { upsert: true },
            )
        } catch (err) {
            if ((err as { code?: unknown })?.code !== DUPLICATE_KEY) {
                throw err
            }
        }
    }
}
