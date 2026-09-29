import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { type Analysis, JobErrorCode, type JobMedia, JobStatus, RequestErrorCode } from 'adlens-shared'
import { type FilterQuery, Model } from 'mongoose'
import { ApiException } from '../common/api-exception'
import { JOB_MODEL, type JobDoc, type StoredJob, type TokenUsage } from '../database/job.doc'
import { IpQuotaService } from '../ip-quota/ip-quota.service'
import type { IpCharge } from '../ip-quota/ip-rules'
import { QuotaService } from '../quota/quota.service'

const VERIFY_STALE_MS = 10 * 60 * 1000
// Past the worker's worst case: a 15-minute task timeout across 3 attempts, plus start-up time.
const ANALYSIS_STALE_MS = 60 * 60 * 1000

const IN_FLIGHT = [JobStatus.Queued, JobStatus.Analyzing]

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

    // analyzing → analyzed. false when the job was finalized elsewhere meanwhile (e.g. expired as stale).
    async complete(jobId: string, analysis: Analysis, usage: TokenUsage): Promise<boolean> {
        const done = await this.transition(
            { _id: jobId, status: JobStatus.Analyzing },
            { status: JobStatus.Analyzed, analysis, usage },
        )

        return done !== null
    }

    // queued / analyzing → error, refunding the charge at most once.
    async fail(jobId: string, errorCode: JobErrorCode, detail: string): Promise<boolean> {
        return this.settle(
            { _id: jobId, status: { $in: IN_FLIGHT } },
            { status: JobStatus.Error, errorCode, errorDetail: detail },
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
    private async settle(filter: FilterQuery<JobDoc>, set: Partial<JobDoc>): Promise<boolean> {
        const before = await this.model
            .findOneAndUpdate(filter, { $set: { ...set, chargedRunId: null, chargedIpRunId: null } }, { new: false })
            .lean<StoredJob>()

        if (!before) {
            return false
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
