import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { type Analysis, JobErrorCode, type JobMedia, JobStatus, RequestErrorCode } from 'adlens-shared'
import { type FilterQuery, Model, Types } from 'mongoose'
import { ApiException } from '../common/api-exception'
import { describeError } from '../common/error-message'
import { JOB_MODEL, type JobDoc, type ModelCall, type StoredJob } from '../database/job.doc'
import { IpQuotaService } from '../ip-quota/ip-quota.service'
import type { IpCharge } from '../ip-quota/ip-rules'
import { LivePublisher } from '../live/live-publisher'
import { QuotaService } from '../quota/quota.service'
import { UNSTARTED_JOB_MS } from './job-status'
import { toStoredAnalysis } from './job.mapper'

// Whether this attempt set the call mark, found it set by an earlier attempt, or found the job no longer analyzed.
type CallMarking = 'marked' | 'repeated' | 'ended'

type HeldCharges = Pick<StoredJob, '_id' | 'userId' | 'chargedRunId' | 'chargedIpRunId'>

interface ExpirySweepResult {
    expired: number
    failed: number
}

interface RefundSweepResult {
    refunded: number
    failed: number
}

const VERIFY_STALE_MS = 10 * 60 * 1000
// Counted from the queueing (or a refused call), not from the last write: a worker that hasn't started its Gemini call 5
// minutes after the job was queued (dispatch, boot and the ruleset take under a minute) never will.
const STARTING_STALE_MS = 5 * 60 * 1000
// Counted from the start of the Gemini call: longer than the reviewer's 10-minute request timeout, so a live worker
// always settles the job itself and a billed answer is never thrown away by the sweep.
const MODEL_CALL_STALE_MS = 12 * 60 * 1000

const IN_FLIGHT = [JobStatus.Queued, JobStatus.Analyzing]
// A job keeps its charges while its run is in flight and once it has a result. In any other status, charges it still
// holds are owed back: their refund failed or was cut short, or chargeAndQueue couldn't finish.
const OWING = [JobStatus.Pending, JobStatus.Verifying, JobStatus.Error]
// Not `verifying`: chargeAndQueue holds the charges it is taking there until the job is queued.
const SWEPT = [JobStatus.Pending, JobStatus.Error]

const HELD_CHARGES_PROJECTION = { userId: 1, chargedRunId: 1, chargedIpRunId: 1 }

const newRunId = () => new Types.ObjectId().toString()

// What makes a job abandoned, per status. Both the sweep's find and each job's final write use it.
const staleConditions = (now: Date): FilterQuery<JobDoc>[] => {
    const startingCutoff = new Date(now.getTime() - STARTING_STALE_MS)

    return [
        // Aged from its creation: no step of the upload touches the job.
        { status: JobStatus.Pending, createdAt: { $lt: new Date(now.getTime() - UNSTARTED_JOB_MS) } },
        { status: JobStatus.Verifying, updatedAt: { $lt: new Date(now.getTime() - VERIFY_STALE_MS) } },
        // A refused call clears the mark and restarts this clock (clearModelCall).
        { status: { $in: IN_FLIGHT }, modelCallStartedAt: { $exists: false }, queuedAt: { $lt: startingCutoff } },
        // Queued before queuedAt was recorded: timed from its last write instead.
        {
            status: { $in: IN_FLIGHT },
            modelCallStartedAt: { $exists: false },
            queuedAt: { $exists: false },
            updatedAt: { $lt: startingCutoff },
        },
        { status: { $in: IN_FLIGHT }, modelCallStartedAt: { $lt: new Date(now.getTime() - MODEL_CALL_STALE_MS) } },
    ]
}

const jobChanged = () =>
    new ApiException(HttpStatus.CONFLICT, RequestErrorCode.JobNotPending, 'Job changed during verification')

// Adds a billed call to the job: to the totals across all its attempts, and to the list of calls kept for pricing.
const recordCall = (call: ModelCall) => ({
    $inc: {
        'usage.promptTokens': call.promptTokens,
        'usage.outputTokens': call.candidatesTokens + call.thoughtsTokens,
        'usage.totalTokens': call.totalTokens,
    },
    $push: { 'usage.calls': call },
})

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
        private readonly live: LivePublisher,
    ) {}

    // pending → verifying. null when the job isn't the caller's pending job.
    async claimForVerification(userId: string, jobId: string): Promise<StoredJob | null> {
        return this.transition({ _id: jobId, userId, status: JobStatus.Pending }, { status: JobStatus.Verifying })
    }

    // verifying → error, refunding whatever the job still holds: the run couldn't start (the upload was rejected,
    // missing or couldn't be checked, the sample is gone, or it couldn't be charged). Never back to pending: the web
    // never starts a job twice, it creates a new one, so a job put back would stay pending for good. false when the
    // job already left verification.
    async failStart(jobId: string, errorCode: JobErrorCode, detail?: string): Promise<boolean> {
        return this.settle(
            { _id: jobId, status: JobStatus.Verifying },
            { status: JobStatus.Error, errorCode, ...(detail ? { errorDetail: detail } : {}) },
        )
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
        const runId = newRunId()
        const ipRunId = newRunId()

        // A job put back to pending before 2026-10-02 may still hold charges whose refund failed; recording new ones
        // would lose them.
        await this.refundHeldCharges(jobId)

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
                { status: JobStatus.Queued, media, queuedAt: new Date() },
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

    // queued → error with the charges refunded, when the worker couldn't be started. Like any failed start, never back
    // to pending. Only from queued, so a worker that did start meanwhile keeps its analysis.
    async failDispatch(jobId: string): Promise<void> {
        await this.settle(
            { _id: jobId, status: JobStatus.Queued },
            {
                status: JobStatus.Error,
                errorCode: JobErrorCode.AnalysisFailed,
                errorDetail: 'No worker could be started',
            },
        )
    }

    // queued / analyzing → analyzing for one worker attempt. null when the job is already final or unknown.
    async startAttempt(jobId: string): Promise<StoredJob | null> {
        const job = await this.model
            .findOneAndUpdate(
                { _id: jobId, status: { $in: IN_FLIGHT } },
                { $set: { status: JobStatus.Analyzing }, $inc: { attempts: 1 } },
                { new: true },
            )
            .lean<StoredJob>()

        if (job) {
            await this.live.publishJob(job)
        }

        return job
    }

    // Marks the attempt's Gemini call as started, so no later attempt makes one again. 'repeated' when an earlier
    // attempt already started one (it may have been billed), 'ended' when the job is no longer being analyzed.
    async markModelCall(jobId: string, now = new Date()): Promise<CallMarking> {
        const marked = await this.model.updateOne(
            { _id: jobId, status: JobStatus.Analyzing, modelCallStartedAt: { $exists: false } },
            { $set: { modelCallStartedAt: now } },
        )

        if (marked.modifiedCount > 0) {
            return 'marked'
        }

        const isAnalyzing = await this.model.exists({ _id: jobId, status: JobStatus.Analyzing })

        return isAnalyzing ? 'repeated' : 'ended'
    }

    // Vertex refused the call with an HTTP error status, which Gemini doesn't bill: a retry may call again. The start
    // clock restarts too, or a refusal late in the window would leave Cloud Run's retry on an already expired clock.
    async clearModelCall(jobId: string, now = new Date()): Promise<void> {
        await this.model.updateOne({ _id: jobId }, { $unset: { modelCallStartedAt: 1 }, $set: { queuedAt: now } })
    }

    // analyzing → analyzed. false when the job was finalized elsewhere meanwhile (e.g. expired as stale). The call is
    // added to what earlier, failed attempts recorded, so the job holds everything its analysis was billed for.
    async complete(jobId: string, analysis: Analysis, call: ModelCall): Promise<boolean> {
        const done = await this.model
            .findOneAndUpdate(
                { _id: jobId, status: JobStatus.Analyzing },
                { $set: { status: JobStatus.Analyzed, analysis: toStoredAnalysis(analysis) }, ...recordCall(call) },
                { new: true },
            )
            .lean<StoredJob>()

        if (!done) {
            return false
        }

        await this.live.publishJob(done)

        return true
    }

    // The call of an attempt whose answer couldn't be used: billed all the same. Safe to repeat: a write that failed
    // on the network may still have been applied (complete's included), so a call already recorded is not added again.
    async addUsage(jobId: string, call: ModelCall): Promise<void> {
        await this.model.updateOne({ _id: jobId, 'usage.calls.at': { $ne: call.at } }, recordCall(call))
    }

    // queued / analyzing → error, with the charges refunded in full: a run that ends without a result is never
    // counted, whatever its Gemini call may have cost.
    async fail(jobId: string, errorCode: JobErrorCode, detail: string): Promise<boolean> {
        return this.settle(
            { _id: jobId, status: { $in: IN_FLIGHT } },
            { status: JobStatus.Error, errorCode, errorDetail: detail },
        )
    }

    // Closes this user's abandoned jobs, then retries the refunds their ended jobs still owe, so no charge stays taken
    // for a run that never finished.
    async expireStale(userId: string, now = new Date()): Promise<void> {
        await this.expireStaleJobs(userId, now)
        await this.refundOwedCharges(userId)
    }

    // Closes the jobs abandoned mid-flight (a worker crashed, timed out or never started), so no job shows progress
    // forever, and the jobs never started, whose upload never came or whose run the web never asked for: this user's
    // on every read of their jobs, everyone's in the daily cleanup, for owners who never come back. A job that can't
    // be closed is left for the next run.
    async expireStaleJobs(userId?: string, now = new Date()): Promise<ExpirySweepResult> {
        const stale = await this.findStaleJobs(userId, now)
        const result: ExpirySweepResult = { expired: 0, failed: 0 }

        for (const job of stale) {
            const jobId = job._id.toString()

            try {
                await this.expire(jobId, job.status, now)
                result.expired++
            } catch (err) {
                result.failed++
                this.logger.error(`could not expire job ${jobId}: ${describeError(err)}`)
            }
        }

        return result
    }

    // Retries the refunds that ended jobs still owe: this user's on every read of their jobs, everyone's in the daily
    // cleanup, for networks whose users never come back.
    async refundOwedCharges(userId?: string): Promise<RefundSweepResult> {
        const owing = await this.findOwingJobs(userId)
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

    private findOwingJobs(userId: string | undefined): Promise<HeldCharges[]> {
        return this.model
            .find(
                {
                    ...(userId ? { userId } : {}),
                    status: { $in: SWEPT },
                    $or: [{ chargedRunId: { $ne: null } }, { chargedIpRunId: { $ne: null } }],
                },
                HELD_CHARGES_PROJECTION,
            )
            .lean<HeldCharges[]>()
    }

    private findStaleJobs(userId: string | undefined, now: Date): Promise<Pick<StoredJob, '_id' | 'status'>[]> {
        return this.model
            .find({ ...(userId ? { userId } : {}), $or: staleConditions(now) }, { _id: 1, status: 1 })
            .lean<Pick<StoredJob, '_id' | 'status'>[]>()
    }

    // Each end is guarded on the job still being stale, not only on its status: a worker that set its call mark after
    // the sweep found the job keeps its billed call.
    private async expire(jobId: string, status: JobStatus, now: Date): Promise<void> {
        const stillStale = { _id: jobId, $or: staleConditions(now) }

        switch (status) {
            case JobStatus.Pending:
                await this.settle(
                    { ...stillStale, status: JobStatus.Pending },
                    { status: JobStatus.Error, errorCode: JobErrorCode.UploadFailed, errorDetail: 'Never started' },
                )

                return
            // The API instance died mid-start (verifying, or charging after it); the start's own charges, if it took
            // any, are refunded with it.
            case JobStatus.Verifying:
                await this.settle(
                    { ...stillStale, status: JobStatus.Verifying },
                    {
                        status: JobStatus.Error,
                        errorCode: JobErrorCode.VideoCheckFailed,
                        errorDetail: 'The verification never finished',
                    },
                )

                return
            default: {
                const isExpired = await this.settle(
                    { ...stillStale, status: { $in: IN_FLIGHT } },
                    {
                        status: JobStatus.Error,
                        errorCode: JobErrorCode.AnalysisTimedOut,
                        errorDetail: 'No worker finished the analysis in time',
                    },
                )

                if (isExpired) {
                    this.logger.warn(`job ${jobId} expired while ${status}`)
                }
            }
        }
    }

    private async transition(filter: FilterQuery<JobDoc>, set: Partial<JobDoc>): Promise<StoredJob | null> {
        const job = await this.model.findOneAndUpdate(filter, { $set: set }, { new: true }).lean<StoredJob>()

        if (job) {
            await this.live.publishJob(job)
        }

        return job
    }

    // Applies a guarded status change, then refunds the charges the job holds. A failed refund leaves them on the job,
    // where the next sweep finds them; the status change stands either way. Tabs hear of it after the refund, so a quota
    // they read then no longer counts the run.
    private async settle(filter: FilterQuery<JobDoc>, set: Partial<JobDoc>): Promise<boolean> {
        const settled = await this.model.findOneAndUpdate(filter, { $set: set }, { new: true }).lean<StoredJob>()

        if (!settled) {
            return false
        }

        await this.tryRefund(settled)
        await this.live.publishJob(settled)

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

        // Both refunds run to the end even when one fails, so a failure can't skip the other.
        const refunds = await Promise.allSettled([this.refundUser(job.userId, runId), this.refundNetwork(ipRunId)])
        const failed = refunds.find((refund) => refund.status === 'rejected')

        if (failed) {
            throw failed.reason
        }

        await this.model.updateOne(
            { _id: job._id, status: { $in: OWING }, chargedRunId: runId, chargedIpRunId: ipRunId },
            { $set: { chargedRunId: null, chargedIpRunId: null } },
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
