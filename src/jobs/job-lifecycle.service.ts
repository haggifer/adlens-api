import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { type Analysis, JobErrorCode, type JobMedia, JobStatus, RequestErrorCode } from 'adlens-shared'
import { type FilterQuery, Model } from 'mongoose'
import { ApiException } from '../common/api-exception'
import { JOB_MODEL, type JobDoc, type ModelCall, type StoredJob } from '../database/job.doc'
import { IpQuotaService } from '../ip-quota/ip-quota.service'
import type { IpCharge } from '../ip-quota/ip-rules'
import { QuotaService } from '../quota/quota.service'

const VERIFY_STALE_MS = 10 * 60 * 1000
// Past the worker's worst case: a 15-minute task timeout across 3 attempts, plus start-up time.
const ANALYSIS_STALE_MS = 60 * 60 * 1000

const IN_FLIGHT = [JobStatus.Queued, JobStatus.Analyzing]

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

// The single owner of a job's status. Every transition is one conditional update on the expected current status, so
// racing callers can't both win, and a job's quota charge is released in the same write that ends its run.
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

    // verifying → queued, after charging the network (unless the caller is an admin) and then the user. A charge that
    // can't be kept is given back: the network's when the user's fails, both when the job moved on meanwhile.
    async chargeAndQueue(
        jobId: string,
        userId: string,
        media: JobMedia,
        ipCharge: IpCharge | null = null,
    ): Promise<StoredJob> {
        let ipRunId: string | null = null

        if (ipCharge) {
            ipRunId = await this.ipQuota.charge(ipCharge, jobId)
        }

        let runId: string

        try {
            runId = await this.quota.consume(userId, jobId)
        } catch (err) {
            // The caller needs the reason the user couldn't be charged (e.g. QUOTA_EXCEEDED), not the refund's.
            try {
                await this.refundNetwork(ipRunId)
            } catch (refundErr) {
                this.logger.error(
                    `could not refund network run ${ipRunId} of job ${jobId}: ${refundErr instanceof Error ? refundErr.message : refundErr}`,
                )
            }

            throw err
        }

        const queued = await this.transition(
            { _id: jobId, status: JobStatus.Verifying },
            { status: JobStatus.Queued, media, chargedRunId: runId, chargedIpRunId: ipRunId },
        )

        if (!queued) {
            await Promise.all([this.quota.refund(userId, runId), this.refundNetwork(ipRunId)])
            throw new ApiException(
                HttpStatus.CONFLICT,
                RequestErrorCode.JobNotPending,
                'Job changed during verification',
            )
        }

        return queued
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

    // queued / analyzing → error, refunding the charge at most once.
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
    // job shows progress forever and no charge stays taken for a run that never finished.
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
    }

    private transition(filter: FilterQuery<JobDoc>, set: Partial<JobDoc>): Promise<StoredJob | null> {
        return this.model.findOneAndUpdate(filter, { $set: set }, { new: true }).lean<StoredJob>()
    }

    // Applies a guarded status change and clears the job's charges in the same write. The pre-image says which
    // charges were held, so exactly one caller refunds them.
    private async settle(filter: FilterQuery<JobDoc>, set: Partial<JobDoc>, isRefundCapped = false): Promise<boolean> {
        const before = await this.model
            .findOneAndUpdate(filter, { $set: { ...set, chargedRunId: null, chargedIpRunId: null } }, { new: false })
            .lean<StoredJob>()

        if (!before) {
            return false
        }

        // The network decides: past its allowance of refunded failures, both runs stay counted, which bounds what a
        // video that always fails can cost. A job with no network run (an admin's) is refunded as before.
        if (isRefundCapped && before.chargedIpRunId) {
            const jobId = before._id.toString()
            const isRefunded = await this.ipQuota.refundFailure(before.chargedIpRunId)

            if (!isRefunded) {
                this.logger.warn(`job ${jobId} failed after the network used its refunded failures; it stays counted`)
                return true
            }

            await this.refundUser(before.userId, before.chargedRunId)
            return true
        }

        // Both refunds run to the end even when one fails, so a failure can't skip the other. Jobs charged before the
        // network quota existed have no chargedIpRunId.
        const refunds = await Promise.allSettled([
            this.refundUser(before.userId, before.chargedRunId),
            this.refundNetwork(before.chargedIpRunId ?? null),
        ])
        const failed = refunds.find((refund) => refund.status === 'rejected')

        if (failed) {
            throw failed.reason
        }

        return true
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
