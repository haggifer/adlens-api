import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { type Analysis, JobErrorCode, type JobMedia, JobStatus, RequestErrorCode } from 'adlens-shared'
import { type FilterQuery, Model, Types } from 'mongoose'
import { ApiException } from '../common/api-exception'
import { JOB_MODEL, type JobDoc, type ModelCall, type StoredJob } from '../database/job.doc'
import { IpQuotaService } from '../ip-quota/ip-quota.service'
import type { IpCharge } from '../ip-quota/ip-rules'
import { QuotaService } from '../quota/quota.service'

const VERIFY_STALE_MS = 10 * 60 * 1000
// Past the worker's worst case: a 15-minute task timeout across 3 attempts, plus start-up time.
const ANALYSIS_STALE_MS = 60 * 60 * 1000

const IN_FLIGHT = [JobStatus.Queued, JobStatus.Analyzing]
// A job keeps its charges while its run is in flight and once it has a result. In any other status, charges it still
// holds are owed back: their refund failed or was cut short, or chargeAndQueue couldn't finish.
const OWING = [JobStatus.Pending, JobStatus.Verifying, JobStatus.Error]
// Not `verifying`: chargeAndQueue holds the charges it is taking there until the job is queued.
const SWEPT = [JobStatus.Pending, JobStatus.Error]

type HeldCharges = Pick<StoredJob, '_id' | 'userId' | 'chargedRunId' | 'chargedIpRunId' | 'isRefundCapped'>

const HELD_CHARGES_PROJECTION = { userId: 1, chargedRunId: 1, chargedIpRunId: 1, isRefundCapped: 1 }

const newRunId = () => new Types.ObjectId().toString()

const jobChanged = () =>
    new ApiException(HttpStatus.CONFLICT, RequestErrorCode.JobNotPending, 'Job changed during verification')

const describeError = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Adds a billed call to the job: to the totals across all its attempts, and to the list of calls kept for pricing.
const recordCall = (call: ModelCall) => ({
    $inc: {
        'usage.promptTokens': call.promptTokens,
        'usage.outputTokens': call.candidatesTokens + call.thoughtsTokens,
        'usage.totalTokens': call.totalTokens,
    },
    $push: { 'usage.calls': call },
})

export interface FailOptions {
    // Gemini answered, so the attempt was billed: the refund then counts against the network's allowance of them.
    isAfterModelAnswer?: boolean
}

export interface RefundSweepResult {
    refunded: number
    failed: number
}

// The single owner of a job's status. Every transition is one conditional update on the expected current status, so
// racing callers can't both win. A job holds the ids of its charges until they are refunded: every refund is safe to
// repeat, so a refund that fails or is cut short is simply retried later, and none is lost or made twice.
@Injectable()
export class JobLifecycle {
    private readonly logger = new Logger(JobLifecycle.name)

    constructor(
        @InjectModel(JOB_MODEL) private readonly model: Model<JobDoc>,
        private readonly quota: QuotaService,
        private readonly ipQuota: IpQuotaService,
    ) {}

    // pending → verifying. null when the job isn't the caller's pending job.
    async claimForVerification(userId: string, jobId: string): Promise<StoredJob | null> {
        return this.transition({ _id: jobId, userId, status: JobStatus.Pending }, { status: JobStatus.Verifying })
    }

    // verifying → pending, when verification couldn't finish or the quota ran out, so the user can try again.
    async releaseVerification(jobId: string): Promise<void> {
        await this.transition({ _id: jobId, status: JobStatus.Verifying }, { status: JobStatus.Pending })
    }

    // verifying → error: the upload isn't an acceptable video.
    async rejectVerification(jobId: string, errorCode: JobErrorCode): Promise<void> {
        await this.transition({ _id: jobId, status: JobStatus.Verifying }, { status: JobStatus.Error, errorCode })
    }

    // verifying → queued, after charging the network (unless the caller is an admin) and then the user. The run ids are
    // recorded on the job before either charge, so no charge exists that no job holds: whatever fails or crashes after
    // that, the refund finds it, and refunding a run that was never charged changes nothing.
    async chargeAndQueue(
        jobId: string,
        userId: string,
        media: JobMedia,
        ipCharge: IpCharge | null = null,
    ): Promise<StoredJob> {
        // An earlier run of this job may still hold charges whose refund failed; recording new ones would lose them.
        await this.refundHeldCharges(jobId)

        const runId = newRunId()
        const ipRunId = newRunId()
        const reserved = await this.model.updateOne(
            { _id: jobId, status: JobStatus.Verifying, chargedRunId: null, chargedIpRunId: null },
            { $set: { chargedRunId: runId, chargedIpRunId: ipCharge ? ipRunId : null } },
        )

        if (reserved.modifiedCount === 0) {
            throw jobChanged()
        }

        try {
            if (ipCharge) {
                await this.ipQuota.charge(ipCharge, jobId, new Date(), ipRunId)
            }

            await this.quota.consume(userId, jobId, new Date(), runId)

            const queued = await this.transition(
                { _id: jobId, status: JobStatus.Verifying, chargedRunId: runId },
                { status: JobStatus.Queued, media },
            )

            if (!queued) {
                throw jobChanged()
            }

            return queued
        } catch (err) {
            // The caller needs the reason the job couldn't be queued (e.g. QUOTA_EXCEEDED), not the refund's.
            await this.tryRefundHeldCharges(jobId)
            throw err
        }
    }

    async recordExecution(jobId: string, execution: string): Promise<void> {
        await this.model.updateOne({ _id: jobId }, { $set: { execution } })
    }

    // queued → pending with the charge refunded, when the worker couldn't be started.
    async revertDispatch(jobId: string): Promise<void> {
        await this.settle({ _id: jobId, status: JobStatus.Queued }, { status: JobStatus.Pending })
    }

    // queued / analyzing → analyzing for one worker attempt. null when the job is already final or unknown.
    async startAttempt(jobId: string): Promise<StoredJob | null> {
        return this.model
            .findOneAndUpdate(
                { _id: jobId, status: { $in: IN_FLIGHT } },
                { $set: { status: JobStatus.Analyzing }, $inc: { attempts: 1 } },
                { new: true },
            )
            .lean<StoredJob>()
    }

    // Marks the attempt's Gemini call as started, so no later attempt makes one again. false when an earlier attempt
    // already started one (it may have been billed), or the job is no longer being analyzed.
    async markModelCall(jobId: string, now = new Date()): Promise<boolean> {
        const marked = await this.model.updateOne(
            { _id: jobId, status: JobStatus.Analyzing, modelCallStartedAt: { $exists: false } },
            { $set: { modelCallStartedAt: now } },
        )

        return marked.modifiedCount > 0
    }

    // The call failed without an answer (an HTTP or network error), which Gemini doesn't bill: a retry may call again.
    async clearModelCall(jobId: string): Promise<void> {
        await this.model.updateOne({ _id: jobId }, { $unset: { modelCallStartedAt: 1 } })
    }

    // analyzing → analyzed. false when the job was finalized elsewhere meanwhile (e.g. expired as stale). The call is
    // added to what earlier, failed attempts recorded, so the job holds everything its analysis was billed for.
    async complete(jobId: string, analysis: Analysis, call: ModelCall): Promise<boolean> {
        const done = await this.model.findOneAndUpdate(
            { _id: jobId, status: JobStatus.Analyzing },
            { $set: { status: JobStatus.Analyzed, analysis }, ...recordCall(call) },
            { new: true },
        )

        return done !== null
    }

    // The call of an attempt whose answer couldn't be used: billed all the same.
    async addUsage(jobId: string, call: ModelCall): Promise<void> {
        await this.model.updateOne({ _id: jobId }, recordCall(call))
    }

    // queued / analyzing → error, with the charges refunded.
    async fail(
        jobId: string,
        errorCode: JobErrorCode,
        detail: string,
        { isAfterModelAnswer = false }: FailOptions = {},
    ): Promise<boolean> {
        return this.settle(
            { _id: jobId, status: { $in: IN_FLIGHT } },
            { status: JobStatus.Error, errorCode, errorDetail: detail },
            isAfterModelAnswer,
        )
    }

    // Closes this user's jobs that were abandoned mid-flight (a worker crashed, timed out or never started), so no
    // job shows progress forever, then retries the refunds their ended jobs still owe, so no charge stays taken for a
    // run that never finished.
    async expireStale(userId: string, now = new Date()): Promise<void> {
        const stale = await this.model
            .find(
                {
                    userId,
                    $or: [
                        { status: JobStatus.Verifying, updatedAt: { $lt: new Date(now.getTime() - VERIFY_STALE_MS) } },
                        { status: { $in: IN_FLIGHT }, updatedAt: { $lt: new Date(now.getTime() - ANALYSIS_STALE_MS) } },
                    ],
                },
                { _id: 1, status: 1 },
            )
            .lean<Pick<StoredJob, '_id' | 'status'>[]>()

        for (const job of stale) {
            const jobId = job._id.toString()

            if (job.status === JobStatus.Verifying) {
                await this.releaseVerification(jobId)
                continue
            }

            this.logger.warn(`job ${jobId} expired while ${job.status}`)
            await this.fail(jobId, JobErrorCode.AnalysisTimedOut, 'No worker finished the analysis in time')
        }

        await this.refundOwedCharges(userId)
    }

    // Retries the refunds that ended jobs still owe: this user's on every read of their jobs, everyone's in the daily
    // cleanup, for networks whose users never come back.
    async refundOwedCharges(userId?: string): Promise<RefundSweepResult> {
        const owing = await this.model
            .find(
                {
                    ...(userId ? { userId } : {}),
                    status: { $in: SWEPT },
                    $or: [{ chargedRunId: { $ne: null } }, { chargedIpRunId: { $ne: null } }],
                },
                HELD_CHARGES_PROJECTION,
            )
            .lean<HeldCharges[]>()
        const result: RefundSweepResult = { refunded: 0, failed: 0 }

        for (const job of owing) {
            try {
                await this.refund(job)
                result.refunded++
            } catch (err) {
                result.failed++
                this.logger.error(`could not refund the charges of job ${job._id.toString()}: ${describeError(err)}`)
            }
        }

        return result
    }

    private transition(filter: FilterQuery<JobDoc>, set: Partial<JobDoc>): Promise<StoredJob | null> {
        return this.model.findOneAndUpdate(filter, { $set: set }, { new: true }).lean<StoredJob>()
    }

    // Applies a guarded status change, then refunds the charges the job holds. A failed refund leaves them on the job,
    // where the next sweep finds them; the status change stands either way.
    private async settle(filter: FilterQuery<JobDoc>, set: Partial<JobDoc>, isRefundCapped = false): Promise<boolean> {
        const settled = await this.model
            .findOneAndUpdate(filter, { $set: isRefundCapped ? { ...set, isRefundCapped } : set }, { new: true })
            .lean<StoredJob>()

        if (!settled) {
            return false
        }

        await this.tryRefund(settled)

        return true
    }

    private async refundHeldCharges(jobId: string): Promise<void> {
        const job = await this.model
            .findOne({ _id: jobId, status: { $in: OWING } }, HELD_CHARGES_PROJECTION)
            .lean<HeldCharges>()

        if (job) {
            await this.refund(job)
        }
    }

    private async tryRefundHeldCharges(jobId: string): Promise<void> {
        try {
            await this.refundHeldCharges(jobId)
        } catch (err) {
            this.logger.error(`could not refund the charges of job ${jobId}, kept for a retry: ${describeError(err)}`)
        }
    }

    private async tryRefund(job: HeldCharges): Promise<void> {
        try {
            await this.refund(job)
        } catch (err) {
            this.logger.error(
                `could not refund the charges of job ${job._id.toString()}, kept for a retry: ${describeError(err)}`,
            )
        }
    }

    // Every step is safe to repeat, so two callers refunding the same job, or a retry after a partial refund, take
    // nothing back twice. The ids are cleared only once both refunds are done, and only if no new run replaced them.
    private async refund(job: HeldCharges): Promise<void> {
        const runId = job.chargedRunId
        // Jobs charged before the network quota existed have no chargedIpRunId.
        const ipRunId = job.chargedIpRunId ?? null

        if (!runId && !ipRunId) {
            return
        }

        // The network decides: past its allowance of refunded failures, both runs stay counted, which bounds what a
        // video that always fails can cost. A job with no network run (an admin's) is refunded in full.
        if (job.isRefundCapped && ipRunId) {
            const isRefunded = await this.ipQuota.refundFailure(ipRunId)

            if (isRefunded) {
                await this.refundUser(job.userId, runId)
            } else {
                this.logger.warn(
                    `job ${job._id.toString()} failed after the network used its refunded failures; it stays counted`,
                )
            }
        } else {
            // Both refunds run to the end even when one fails, so a failure can't skip the other.
            const refunds = await Promise.allSettled([this.refundUser(job.userId, runId), this.refundNetwork(ipRunId)])
            const failed = refunds.find((refund) => refund.status === 'rejected')

            if (failed) {
                throw failed.reason
            }
        }

        await this.model.updateOne(
            { _id: job._id, status: { $in: OWING }, chargedRunId: runId, chargedIpRunId: ipRunId },
            { $set: { chargedRunId: null, chargedIpRunId: null }, $unset: { isRefundCapped: 1 } },
        )
    }

    private async refundUser(userId: string, runId: string | null): Promise<void> {
        if (runId) {
            await this.quota.refund(userId, runId)
        }
    }

    private async refundNetwork(runId: string | null): Promise<void> {
        if (runId) {
            await this.ipQuota.refund(runId)
        }
    }
}
