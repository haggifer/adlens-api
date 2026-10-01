import { Logger } from '@nestjs/common'
import {
    type Analysis,
    JobErrorCode,
    type JobMedia,
    JobStatus,
    Placement,
    Platform,
    RequestErrorCode,
    VideoMimeType,
} from 'adlens-shared'
import { type Model, Types } from 'mongoose'
import { UserAccess } from '../common/user-access'
import { IP_QUOTA_COLLECTION, IP_QUOTA_MODEL, type IpQuotaDoc, IpQuotaSchema } from '../database/ip-quota.doc'
import { JOB_MODEL, type JobDoc, JobSchema, type StoredJob } from '../database/job.doc'
import { USER_COLLECTION } from '../database/user.doc'
import { IpQuotaService } from '../ip-quota/ip-quota.service'
import type { IpCharge } from '../ip-quota/ip-rules'
import { QuotaService } from '../quota/quota.service'
import { configStub } from '../testing/config-stub'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { JobLifecycle } from './job-lifecycle.service'
import { buildModelCall, usageOf } from '../testing/model-call'

const USER = new Types.ObjectId().toString()
const OTHER_USER = new Types.ObjectId().toString()
const QUOTA_LIMIT = 3
const MEDIA: JobMedia = {
    durationS: 12,
    width: 1080,
    height: 1920,
    hasAudio: true,
    sizeBytes: 1000,
    contentType: 'video/mp4',
}
const ANALYSIS: Analysis = {
    model: 'fake-model',
    promptVersion: 'test',
    rulesetVersion: '1.0.0',
    transcript: 'Buy now',
    findings: [],
    metadataChecks: [],
    advisories: [],
    completedAt: '2026-09-29T10:00:00.000Z',
}
const CALL = buildModelCall()
const IP_LIMITS = { IP_ANON_LIMIT: 3, IP_SOFT_LIMIT: 10, IP_HARD_LIMIT: 30, IP_FAILURE_REFUND_LIMIT: 1 }
const NETWORK_CHARGE: IpCharge = { bucketKey: 'network-key', access: UserAccess.Member, hasPassedChallenge: false }
// JobLifecycle's own thresholds: a verification or an analysis idle for longer than these was abandoned.
const VERIFY_STALE_MS = 10 * 60 * 1000
const ANALYSIS_STALE_MS = 60 * 60 * 1000
const NOW = new Date('2026-09-29T10:00:00Z')

describe('JobLifecycle', () => {
    let mongo: MemoryMongo
    let jobs: Model<JobDoc>
    let lifecycle: JobLifecycle
    let quota: QuotaService
    let ipQuota: IpQuotaService

    const users = () => mongo.connection.collection(USER_COLLECTION)

    const usedRuns = async () => ((await users().findOne({ _id: new Types.ObjectId(USER) }))?.runs ?? []).length

    const network = () =>
        mongo.connection.collection<IpQuotaDoc>(IP_QUOTA_COLLECTION).findOne({ _id: NETWORK_CHARGE.bucketKey })

    const networkRuns = async () => ((await network())?.runs ?? []).length

    const refundedFailures = async () => ((await network())?.refundedFailures ?? []).length

    const createJob = async (status = JobStatus.Pending, userId = USER): Promise<string> => {
        const job = await jobs.create({
            userId,
            status,
            settings: {
                platforms: [Platform.Meta],
                placements: [Placement.MetaReels],
                markets: [],
                objective: 'Awareness',
            },
            file: { name: 'ad.mp4', contentType: VideoMimeType.Mp4, size: 1000, bucket: 'b', path: 'p' },
            chargedRunId: null,
            chargedIpRunId: null,
        })

        return job._id.toString()
    }

    const findJob = (jobId: string) => jobs.findById(jobId).lean<StoredJob>()

    const claimJob = async (): Promise<string> => {
        const jobId = await createJob()

        await lifecycle.claimForVerification(USER, jobId)

        return jobId
    }

    const queueJob = async (ipCharge: IpCharge | null = null): Promise<string> => {
        const jobId = await claimJob()

        await lifecycle.chargeAndQueue(jobId, USER, MEDIA, ipCharge)

        return jobId
    }

    const useAllUserRuns = async () => {
        for (let i = 0; i < QUOTA_LIMIT; i++) {
            await queueJob(NETWORK_CHARGE)
        }
    }

    // Bypasses Mongoose's timestamps, so the job looks as if it was last touched at that moment.
    const lastTouchedAt = (jobId: string, at: Date) =>
        jobs.collection.updateOne({ _id: new Types.ObjectId(jobId) }, { $set: { updatedAt: at } })

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        jobs = mongo.connection.model<JobDoc>(JOB_MODEL, JobSchema)
        await mongo.connection.model(IP_QUOTA_MODEL, IpQuotaSchema).init()
        quota = new QuotaService(mongo.connection, configStub({ QUOTA_LIMIT }))
        ipQuota = new IpQuotaService(mongo.connection, configStub(IP_LIMITS))
        lifecycle = new JobLifecycle(jobs, quota, ipQuota)
    })

    beforeEach(async () => {
        await users().insertMany([
            { _id: new Types.ObjectId(USER), email: 'user@example.com', emailVerified: true },
            { _id: new Types.ObjectId(OTHER_USER), email: 'other@example.com', emailVerified: true },
        ])
    })

    afterEach(async () => {
        jest.restoreAllMocks()
        await Promise.all([
            jobs.deleteMany({}),
            users().deleteMany({}),
            mongo.connection.collection(IP_QUOTA_COLLECTION).deleteMany({}),
        ])
    })

    afterAll(async () => {
        await mongo.stop()
    })

    describe('verification', () => {
        it('lets exactly one of two concurrent callers claim a pending job', async () => {
            const jobId = await createJob()
            const claims = await Promise.all([
                lifecycle.claimForVerification(USER, jobId),
                lifecycle.claimForVerification(USER, jobId),
            ])

            expect(claims.filter(Boolean)).toHaveLength(1)
            expect((await findJob(jobId))?.status).toBe(JobStatus.Verifying)
        })

        it("doesn't let another user claim the job", async () => {
            const jobId = await createJob()

            expect(await lifecycle.claimForVerification(OTHER_USER, jobId)).toBeNull()
            expect((await findJob(jobId))?.status).toBe(JobStatus.Pending)
        })

        it('puts a job under verification back to pending, and leaves a job that moved on alone', async () => {
            const verifying = await claimJob()
            const queued = await queueJob()

            await lifecycle.releaseVerification(verifying)
            await lifecycle.releaseVerification(queued)

            expect((await findJob(verifying))?.status).toBe(JobStatus.Pending)
            expect((await findJob(queued))?.status).toBe(JobStatus.Queued)
        })

        it('ends a rejected upload in error with its reason, and leaves a job that moved on alone', async () => {
            const verifying = await claimJob()
            const queued = await queueJob()

            await lifecycle.rejectVerification(verifying, JobErrorCode.VideoTooLong)
            await lifecycle.rejectVerification(queued, JobErrorCode.VideoTooLong)

            expect(await findJob(verifying)).toMatchObject({
                status: JobStatus.Error,
                errorCode: JobErrorCode.VideoTooLong,
            })
            expect((await findJob(queued))?.status).toBe(JobStatus.Queued)
        })
    })

    describe('charging and queueing', () => {
        it('charges the user and the network once, and records the measured media and both runs', async () => {
            const jobId = await queueJob(NETWORK_CHARGE)

            expect(await findJob(jobId)).toMatchObject({
                status: JobStatus.Queued,
                media: MEDIA,
                chargedRunId: expect.any(String),
                chargedIpRunId: expect.any(String),
            })
            expect(await usedRuns()).toBe(1)
            expect(await networkRuns()).toBe(1)
        })

        it('charges no network when there is no network charge (an admin), and records that none is held', async () => {
            const jobId = await queueJob(null)

            expect((await findJob(jobId))?.chargedIpRunId).toBeNull()
            expect(await networkRuns()).toBe(0)
            expect(await usedRuns()).toBe(1)
        })

        it('gives the network run back when the user has no analyses left', async () => {
            await useAllUserRuns()

            const jobId = await claimJob()

            await expect(lifecycle.chargeAndQueue(jobId, USER, MEDIA, NETWORK_CHARGE)).rejects.toMatchObject({
                response: { errorCode: RequestErrorCode.QuotaExceeded },
            })
            expect(await networkRuns()).toBe(QUOTA_LIMIT)
            expect((await findJob(jobId))?.status).toBe(JobStatus.Verifying)
        })

        it('reports why the user could not be charged, even when giving the network run back fails', async () => {
            await useAllUserRuns()

            const jobId = await claimJob()
            const logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

            jest.spyOn(ipQuota, 'refund').mockRejectedValueOnce(new Error('network refund failed'))

            await expect(lifecycle.chargeAndQueue(jobId, USER, MEDIA, NETWORK_CHARGE)).rejects.toMatchObject({
                response: { errorCode: RequestErrorCode.QuotaExceeded },
            })
            expect(logError).toHaveBeenCalledWith(expect.stringContaining('network refund failed'))
            expect((await findJob(jobId))?.chargedIpRunId).toEqual(expect.any(String))
        })

        it('refunds both runs before rethrowing when queueing the charged job fails', async () => {
            const jobId = await claimJob()

            jest.spyOn(jobs, 'findOneAndUpdate').mockImplementationOnce(() => {
                throw new Error('write failed')
            })

            await expect(lifecycle.chargeAndQueue(jobId, USER, MEDIA, NETWORK_CHARGE)).rejects.toThrow('write failed')
            expect(await findJob(jobId)).toMatchObject({
                status: JobStatus.Verifying,
                chargedRunId: null,
                chargedIpRunId: null,
            })
            expect(await usedRuns()).toBe(0)
            expect(await networkRuns()).toBe(0)
        })

        it('records the runs on the job before charging, so a refund that fails then is retried later', async () => {
            const jobId = await claimJob()

            jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
            jest.spyOn(jobs, 'findOneAndUpdate').mockImplementationOnce(() => {
                throw new Error('write failed')
            })
            jest.spyOn(quota, 'refund').mockRejectedValueOnce(new Error('user refund failed'))

            await expect(lifecycle.chargeAndQueue(jobId, USER, MEDIA, NETWORK_CHARGE)).rejects.toThrow('write failed')
            expect((await findJob(jobId))?.chargedRunId).toEqual(expect.any(String))
            expect(await usedRuns()).toBe(1)

            // What the caller does next: the job goes back to pending, where the next sweep finds the charge.
            await lifecycle.releaseVerification(jobId)
            await lifecycle.expireStale(USER, NOW)

            expect(await findJob(jobId)).toMatchObject({ chargedRunId: null, chargedIpRunId: null })
            expect(await usedRuns()).toBe(0)
            expect(await networkRuns()).toBe(0)
        })

        it('refunds what an earlier run of the job still holds before charging it again', async () => {
            const jobId = await queueJob(NETWORK_CHARGE)

            jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
            jest.spyOn(ipQuota, 'refund').mockRejectedValueOnce(new Error('network refund failed'))
            await lifecycle.revertDispatch(jobId)
            expect(await networkRuns()).toBe(1)

            await lifecycle.claimForVerification(USER, jobId)
            const queued = await lifecycle.chargeAndQueue(jobId, USER, MEDIA, NETWORK_CHARGE)

            expect(queued.status).toBe(JobStatus.Queued)
            expect(await usedRuns()).toBe(1)
            expect(await networkRuns()).toBe(1)
            expect((await network())?.runs[0].id).toBe(queued.chargedIpRunId)
        })

        it('refunds both the user run and the network run when the job left verification meanwhile', async () => {
            const jobId = await claimJob()

            // What expireStale does to a verification it takes for abandoned, racing the charge.
            await lifecycle.releaseVerification(jobId)

            await expect(lifecycle.chargeAndQueue(jobId, USER, MEDIA, NETWORK_CHARGE)).rejects.toMatchObject({
                response: { errorCode: RequestErrorCode.JobNotPending },
            })
            expect(await findJob(jobId)).toMatchObject({
                status: JobStatus.Pending,
                chargedRunId: null,
                chargedIpRunId: null,
            })
            expect(await usedRuns()).toBe(0)
            expect(await networkRuns()).toBe(0)
        })
    })

    describe('ending a run', () => {
        it('puts a job back to pending with both charges refunded when dispatch fails', async () => {
            const jobId = await queueJob(NETWORK_CHARGE)

            await lifecycle.revertDispatch(jobId)

            expect(await findJob(jobId)).toMatchObject({
                status: JobStatus.Pending,
                chargedRunId: null,
                chargedIpRunId: null,
            })
            expect(await usedRuns()).toBe(0)
            expect(await networkRuns()).toBe(0)
        })

        it('starts attempts only for in-flight jobs and counts them', async () => {
            const jobId = await queueJob()

            expect((await lifecycle.startAttempt(jobId))?.attempts).toBe(1)
            expect((await lifecycle.startAttempt(jobId))?.attempts).toBe(2)

            await lifecycle.fail(jobId, JobErrorCode.AnalysisFailed, 'boom')

            expect(await lifecycle.startAttempt(jobId)).toBeNull()
            expect(await lifecycle.startAttempt(new Types.ObjectId().toString())).toBeNull()
        })

        it('stores the result of a job being analyzed and keeps its charges', async () => {
            const jobId = await queueJob(NETWORK_CHARGE)

            await lifecycle.startAttempt(jobId)

            expect(await lifecycle.complete(jobId, ANALYSIS, CALL)).toBe(true)
            expect(await findJob(jobId)).toMatchObject({
                status: JobStatus.Analyzed,
                analysis: ANALYSIS,
                usage: usageOf(CALL),
                chargedRunId: expect.any(String),
                chargedIpRunId: expect.any(String),
            })
            expect(await usedRuns()).toBe(1)
            expect(await networkRuns()).toBe(1)
        })

        it('drops the result of a job that is not being analyzed, e.g. one that expired meanwhile', async () => {
            const queued = await queueJob()
            const expired = await queueJob()

            await lifecycle.startAttempt(expired)
            await lifecycle.fail(expired, JobErrorCode.AnalysisTimedOut, 'expired')

            expect(await lifecycle.complete(queued, ANALYSIS, CALL)).toBe(false)
            expect(await lifecycle.complete(expired, ANALYSIS, CALL)).toBe(false)
            const job = await findJob(expired)

            expect(job?.status).toBe(JobStatus.Error)
            expect(job).not.toHaveProperty('analysis')
        })

        it('refunds both runs of a failed job exactly once, even when failure is reported twice', async () => {
            const jobId = await queueJob(NETWORK_CHARGE)
            const results = await Promise.all([
                lifecycle.fail(jobId, JobErrorCode.AnalysisFailed, 'boom'),
                lifecycle.fail(jobId, JobErrorCode.AnalysisFailed, 'boom'),
            ])

            expect(results.filter(Boolean)).toHaveLength(1)
            expect(await findJob(jobId)).toMatchObject({
                status: JobStatus.Error,
                errorCode: JobErrorCode.AnalysisFailed,
                errorDetail: 'boom',
                chargedRunId: null,
                chargedIpRunId: null,
            })
            expect(await usedRuns()).toBe(0)
            expect(await networkRuns()).toBe(0)
        })

        it("doesn't fail a job that already has a result, nor refund it", async () => {
            const jobId = await queueJob(NETWORK_CHARGE)

            await lifecycle.startAttempt(jobId)
            await lifecycle.complete(jobId, ANALYSIS, CALL)

            expect(await lifecycle.fail(jobId, JobErrorCode.AnalysisFailed, 'late')).toBe(false)
            expect((await findJob(jobId))?.status).toBe(JobStatus.Analyzed)
            expect(await usedRuns()).toBe(1)
            expect(await networkRuns()).toBe(1)
        })

        it('still refunds the network run when refunding the user run fails, and keeps the user run to retry', async () => {
            const jobId = await queueJob(NETWORK_CHARGE)

            jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
            jest.spyOn(quota, 'refund').mockRejectedValueOnce(new Error('user refund failed'))

            expect(await lifecycle.fail(jobId, JobErrorCode.AnalysisFailed, 'boom')).toBe(true)
            expect(await findJob(jobId)).toMatchObject({
                status: JobStatus.Error,
                chargedRunId: expect.any(String),
                chargedIpRunId: expect.any(String),
            })
            expect(await usedRuns()).toBe(1)
            expect(await networkRuns()).toBe(0)

            await lifecycle.expireStale(USER, NOW)

            expect(await findJob(jobId)).toMatchObject({ chargedRunId: null, chargedIpRunId: null })
            expect(await usedRuns()).toBe(0)
            expect(await networkRuns()).toBe(0)
        })

        it('keeps the charges of a job put back to pending until their refund succeeds', async () => {
            const jobId = await queueJob(NETWORK_CHARGE)

            jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
            jest.spyOn(ipQuota, 'refund').mockRejectedValueOnce(new Error('network refund failed'))

            await lifecycle.revertDispatch(jobId)

            expect(await findJob(jobId)).toMatchObject({
                status: JobStatus.Pending,
                chargedIpRunId: expect.any(String),
            })
            expect(await networkRuns()).toBe(1)

            await lifecycle.expireStale(USER, NOW)

            expect(await findJob(jobId)).toMatchObject({ chargedRunId: null, chargedIpRunId: null })
            expect(await usedRuns()).toBe(0)
            expect(await networkRuns()).toBe(0)
        })

        it('refunds a run that failed after a possibly billed call from the allowance once, even when retried', async () => {
            const jobId = await queueJob(NETWORK_CHARGE)

            jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
            jest.spyOn(quota, 'refund').mockRejectedValueOnce(new Error('user refund failed'))

            await lifecycle.fail(jobId, JobErrorCode.AnalysisFailed, 'malformed', { isPossiblyBilled: true })
            expect(await usedRuns()).toBe(1)

            await lifecycle.expireStale(USER, NOW)

            expect(await findJob(jobId)).toMatchObject({ chargedRunId: null, chargedIpRunId: null })
            expect(await usedRuns()).toBe(0)
            expect(await networkRuns()).toBe(0)
            expect(await refundedFailures()).toBe(1)
        })

        it('keeps both runs counted once the network used its refunds, and clears the job all the same', async () => {
            const refunded = await queueJob(NETWORK_CHARGE)
            const kept = await queueJob(NETWORK_CHARGE)

            jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
            await lifecycle.fail(refunded, JobErrorCode.AnalysisFailed, 'malformed', { isPossiblyBilled: true })
            await lifecycle.fail(kept, JobErrorCode.AnalysisFailed, 'malformed', { isPossiblyBilled: true })
            await lifecycle.expireStale(USER, NOW)

            expect(await findJob(kept)).toMatchObject({ chargedRunId: null, chargedIpRunId: null })
            expect(await usedRuns()).toBe(1)
            expect(await networkRuns()).toBe(1)
        })
    })

    describe('expiring abandoned jobs', () => {
        it('releases a verification and fails an analysis, refunded, once each is idle past its limit', async () => {
            const verifying = await claimJob()
            const analyzing = await queueJob(NETWORK_CHARGE)

            await lifecycle.startAttempt(analyzing)
            await lastTouchedAt(verifying, new Date(NOW.getTime() - VERIFY_STALE_MS - 1))
            await lastTouchedAt(analyzing, new Date(NOW.getTime() - ANALYSIS_STALE_MS - 1))

            await lifecycle.expireStale(USER, NOW)

            expect((await findJob(verifying))?.status).toBe(JobStatus.Pending)
            expect(await findJob(analyzing)).toMatchObject({
                status: JobStatus.Error,
                errorCode: JobErrorCode.AnalysisTimedOut,
                chargedRunId: null,
                chargedIpRunId: null,
            })
            expect(await usedRuns()).toBe(0)
            expect(await networkRuns()).toBe(0)
        })

        it('keeps jobs idle for exactly their limit, and gives an analysis longer than a verification', async () => {
            const verifying = await claimJob()
            const queued = await queueJob()
            const analyzing = await queueJob()

            await lifecycle.startAttempt(analyzing)
            await lastTouchedAt(verifying, new Date(NOW.getTime() - VERIFY_STALE_MS))
            await lastTouchedAt(queued, new Date(NOW.getTime() - ANALYSIS_STALE_MS))
            await lastTouchedAt(analyzing, new Date(NOW.getTime() - VERIFY_STALE_MS - 1))

            await lifecycle.expireStale(USER, NOW)

            expect((await findJob(verifying))?.status).toBe(JobStatus.Verifying)
            expect((await findJob(queued))?.status).toBe(JobStatus.Queued)
            expect((await findJob(analyzing))?.status).toBe(JobStatus.Analyzing)
            expect(await usedRuns()).toBe(2)
        })

        it('leaves the charges of in-flight and analyzed jobs alone', async () => {
            const queued = await queueJob(NETWORK_CHARGE)
            const analyzed = await queueJob(NETWORK_CHARGE)

            await lifecycle.startAttempt(analyzed)
            await lifecycle.complete(analyzed, ANALYSIS, CALL)

            await lifecycle.expireStale(USER, NOW)
            await lifecycle.refundOwedCharges()

            expect((await findJob(queued))?.chargedRunId).toEqual(expect.any(String))
            expect((await findJob(analyzed))?.chargedRunId).toEqual(expect.any(String))
            expect(await usedRuns()).toBe(2)
            expect(await networkRuns()).toBe(2)
        })

        it("only expires the given user's jobs", async () => {
            const othersJob = await createJob(JobStatus.Verifying, OTHER_USER)

            await lastTouchedAt(othersJob, new Date(NOW.getTime() - ANALYSIS_STALE_MS - 1))

            await lifecycle.expireStale(USER, NOW)

            expect((await findJob(othersJob))?.status).toBe(JobStatus.Verifying)
        })

        it("expires every user's abandoned jobs in the daily sweep, and counts them", async () => {
            const own = await queueJob(NETWORK_CHARGE)
            const othersJob = await createJob(JobStatus.Analyzing, OTHER_USER)

            jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
            await lastTouchedAt(own, new Date(NOW.getTime() - ANALYSIS_STALE_MS - 1))
            await lastTouchedAt(othersJob, new Date(NOW.getTime() - ANALYSIS_STALE_MS - 1))

            expect(await lifecycle.expireStaleJobs(undefined, NOW)).toEqual({ expired: 2, failed: 0 })
            expect(await findJob(own)).toMatchObject({
                status: JobStatus.Error,
                errorCode: JobErrorCode.AnalysisTimedOut,
                chargedRunId: null,
                chargedIpRunId: null,
            })
            expect((await findJob(othersJob))?.status).toBe(JobStatus.Error)
            expect(await usedRuns()).toBe(0)
            expect(await networkRuns()).toBe(0)
        })

        it('counts a job the sweep could not expire, and goes on with the others', async () => {
            const first = await createJob(JobStatus.Verifying)
            const second = await createJob(JobStatus.Verifying, OTHER_USER)

            await lastTouchedAt(first, new Date(NOW.getTime() - VERIFY_STALE_MS - 1))
            await lastTouchedAt(second, new Date(NOW.getTime() - VERIFY_STALE_MS - 1))
            jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
            jest.spyOn(jobs, 'findOneAndUpdate').mockImplementationOnce(() => {
                throw new Error('write failed')
            })

            expect(await lifecycle.expireStaleJobs(undefined, NOW)).toEqual({ expired: 1, failed: 1 })
            expect([(await findJob(first))?.status, (await findJob(second))?.status]).toEqual(
                expect.arrayContaining([JobStatus.Verifying, JobStatus.Pending]),
            )
        })
    })

    describe('the daily sweep of owed refunds', () => {
        it("refunds every user's ended jobs that still hold charges, and counts them", async () => {
            const jobId = await queueJob(NETWORK_CHARGE)

            jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
            jest.spyOn(quota, 'refund').mockRejectedValueOnce(new Error('user refund failed'))
            await lifecycle.fail(jobId, JobErrorCode.AnalysisTimedOut, 'expired')

            expect(await lifecycle.refundOwedCharges()).toEqual({ refunded: 1, failed: 0 })
            expect(await findJob(jobId)).toMatchObject({ chargedRunId: null, chargedIpRunId: null })
            expect(await usedRuns()).toBe(0)
            expect(await lifecycle.refundOwedCharges()).toEqual({ refunded: 0, failed: 0 })
        })

        it('counts a refund that fails again, and keeps its charges for the next sweep', async () => {
            const jobId = await queueJob(NETWORK_CHARGE)

            jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
            jest.spyOn(quota, 'refund').mockRejectedValue(new Error('user refund failed'))
            await lifecycle.fail(jobId, JobErrorCode.AnalysisTimedOut, 'expired')

            expect(await lifecycle.refundOwedCharges()).toEqual({ refunded: 0, failed: 1 })
            expect((await findJob(jobId))?.chargedRunId).toEqual(expect.any(String))
        })
    })
})
