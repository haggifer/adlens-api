import { Logger } from '@nestjs/common'
import {
    type Analysis,
    getLiveChannel,
    JobErrorCode,
    type JobMedia,
    JobStatus,
    LiveEvent,
    Placement,
    Platform,
    RequestErrorCode,
    VideoMimeType,
} from 'adlens-shared'
import { type FilterQuery, type Model, Types } from 'mongoose'
import { UserAccess } from '../common/user-access'
import { IP_QUOTA_COLLECTION, IP_QUOTA_MODEL, type IpQuotaDoc, IpQuotaSchema } from '../database/ip-quota.doc'
import { DEMO_OWNER, JOB_MODEL, type JobDoc, JobSchema, type StoredJob } from '../database/job.doc'
import { USER_COLLECTION } from '../database/user.doc'
import { IpQuotaService } from '../ip-quota/ip-quota.service'
import type { IpCharge } from '../ip-quota/ip-rules'
import { QuotaService } from '../quota/quota.service'
import { configStub } from '../testing/config-stub'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { buildModelCall, usageOf } from '../testing/model-call'
import { RecordingLivePublisher } from '../testing/recording-live-publisher'
import { JobLifecycle } from './job-lifecycle.service'
import { UNSTARTED_JOB_MS } from './job-status'

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
const IP_LIMITS = { IP_ANON_LIMIT: 3, IP_SOFT_LIMIT: 10, IP_HARD_LIMIT: 30 }
const NETWORK_CHARGE: IpCharge = { bucketKey: 'network-key', access: UserAccess.Member, hasPassedChallenge: false }
// JobLifecycle's own thresholds: a verification idle for longer, an analysis queued for longer without its Gemini call
// started, or a Gemini call running for longer, was abandoned.
const VERIFY_STALE_MS = 10 * 60 * 1000
const STARTING_STALE_MS = 5 * 60 * 1000
const MODEL_CALL_STALE_MS = 12 * 60 * 1000
const NOW = new Date('2026-09-29T10:00:00Z')

describe('JobLifecycle', () => {
    let mongo: MemoryMongo
    let jobs: Model<JobDoc>
    let lifecycle: JobLifecycle
    let quota: QuotaService
    let ipQuota: IpQuotaService
    let live: RecordingLivePublisher

    const users = () => mongo.connection.collection(USER_COLLECTION)

    const usedRuns = async () => ((await users().findOne({ _id: new Types.ObjectId(USER) }))?.runs ?? []).length

    const network = () =>
        mongo.connection.collection<IpQuotaDoc>(IP_QUOTA_COLLECTION).findOne({ _id: NETWORK_CHARGE.bucketKey })

    const networkRuns = async () => ((await network())?.runs ?? []).length

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
    const createdAt = (jobId: string, at: Date) =>
        jobs.collection.updateOne({ _id: new Types.ObjectId(jobId) }, { $set: { createdAt: at } })

    const lastTouchedAt = (jobId: string, at: Date) =>
        jobs.collection.updateOne({ _id: new Types.ObjectId(jobId) }, { $set: { updatedAt: at } })

    const wasQueuedAt = (jobId: string, at: Date) =>
        jobs.collection.updateOne({ _id: new Types.ObjectId(jobId) }, { $set: { queuedAt: at } })

    const callStartedAt = async (jobId: string, at: Date) => {
        await lifecycle.startAttempt(jobId)
        await lifecycle.markModelCall(jobId, at)
    }

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        jobs = mongo.connection.model<JobDoc>(JOB_MODEL, JobSchema)
        await mongo.connection.model(IP_QUOTA_MODEL, IpQuotaSchema).init()
        quota = new QuotaService(mongo.connection, configStub({ QUOTA_LIMIT }))
        ipQuota = new IpQuotaService(mongo.connection, configStub(IP_LIMITS))
        live = new RecordingLivePublisher()
        lifecycle = new JobLifecycle(jobs, quota, ipQuota, live)
    })

    beforeEach(async () => {
        await users().insertMany([
            { _id: new Types.ObjectId(USER), email: 'user@example.com', emailVerified: true },
            { _id: new Types.ObjectId(OTHER_USER), email: 'other@example.com', emailVerified: true },
        ])
    })

    afterEach(async () => {
        jest.restoreAllMocks()
        live.clear()
        live.failure = null
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

        it.each([JobErrorCode.VideoTooLong, JobErrorCode.UploadFailed, JobErrorCode.VideoCheckFailed])(
            'ends a start that failed with %s in error, never back to pending, and leaves a job that moved on alone',
            async (errorCode) => {
                const verifying = await claimJob()
                const queued = await queueJob()

                expect(await lifecycle.failStart(verifying, errorCode, 'why')).toBe(true)
                expect(await lifecycle.failStart(queued, errorCode)).toBe(false)

                expect(await findJob(verifying)).toMatchObject({
                    status: JobStatus.Error,
                    errorCode,
                    errorDetail: 'why',
                })
                expect((await findJob(queued))?.status).toBe(JobStatus.Queued)
            },
        )
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

            // What the caller does next: ending the start refunds what the job still holds.
            await lifecycle.failStart(jobId, JobErrorCode.AnalysisFailed)

            expect(await findJob(jobId)).toMatchObject({
                status: JobStatus.Error,
                chargedRunId: null,
                chargedIpRunId: null,
            })
            expect(await usedRuns()).toBe(0)
            expect(await networkRuns()).toBe(0)
        })

        it('refunds what an earlier run of the job still holds before charging it again', async () => {
            const jobId = await queueJob(NETWORK_CHARGE)

            // Until 2026-10-02 a failed dispatch put the job back to pending, holding charges whose refund failed.
            await jobs.collection.updateOne({ _id: new Types.ObjectId(jobId) }, { $set: { status: JobStatus.Pending } })
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
            await lifecycle.failStart(jobId, JobErrorCode.VideoCheckFailed)

            await expect(lifecycle.chargeAndQueue(jobId, USER, MEDIA, NETWORK_CHARGE)).rejects.toMatchObject({
                response: { errorCode: RequestErrorCode.JobNotPending },
            })
            expect(await findJob(jobId)).toMatchObject({
                status: JobStatus.Error,
                chargedRunId: null,
                chargedIpRunId: null,
            })
            expect(await usedRuns()).toBe(0)
            expect(await networkRuns()).toBe(0)
        })
    })

    describe('ending a run', () => {
        it('ends a job whose worker could not be started in error, with both charges refunded', async () => {
            const jobId = await queueJob(NETWORK_CHARGE)

            await lifecycle.failDispatch(jobId)

            expect(await findJob(jobId)).toMatchObject({
                status: JobStatus.Error,
                errorCode: JobErrorCode.AnalysisFailed,
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

        it('keeps the charges of a job whose worker could not be started until their refund succeeds', async () => {
            const jobId = await queueJob(NETWORK_CHARGE)

            jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
            jest.spyOn(ipQuota, 'refund').mockRejectedValueOnce(new Error('network refund failed'))

            await lifecycle.failDispatch(jobId)

            expect(await findJob(jobId)).toMatchObject({
                status: JobStatus.Error,
                chargedIpRunId: expect.any(String),
            })
            expect(await networkRuns()).toBe(1)

            await lifecycle.expireStale(USER, NOW)

            expect(await findJob(jobId)).toMatchObject({ chargedRunId: null, chargedIpRunId: null })
            expect(await usedRuns()).toBe(0)
            expect(await networkRuns()).toBe(0)
        })
    })

    describe('expiring abandoned jobs', () => {
        it('fails a verification idle past its limit and an analysis queued past its, refunded', async () => {
            const verifying = await claimJob()
            const analyzing = await queueJob(NETWORK_CHARGE)

            await lifecycle.startAttempt(analyzing)
            await lastTouchedAt(verifying, new Date(NOW.getTime() - VERIFY_STALE_MS - 1))
            await wasQueuedAt(analyzing, new Date(NOW.getTime() - STARTING_STALE_MS - 1))
            // A worker's later writes (an attempt) don't buy the analysis more time.
            await lastTouchedAt(analyzing, NOW)

            await lifecycle.expireStale(USER, NOW)

            // The web never starts a job twice, so a verification that never finished ends the run.
            expect(await findJob(verifying)).toMatchObject({
                status: JobStatus.Error,
                errorCode: JobErrorCode.VideoCheckFailed,
            })
            expect(await findJob(analyzing)).toMatchObject({
                status: JobStatus.Error,
                errorCode: JobErrorCode.AnalysisTimedOut,
                chargedRunId: null,
                chargedIpRunId: null,
            })
            expect(await usedRuns()).toBe(0)
            expect(await networkRuns()).toBe(0)
        })

        it('keeps jobs for exactly their limit', async () => {
            const verifying = await claimJob()
            const queued = await queueJob()
            const analyzing = await queueJob()

            await lifecycle.startAttempt(analyzing)
            await lastTouchedAt(verifying, new Date(NOW.getTime() - VERIFY_STALE_MS))
            await wasQueuedAt(queued, new Date(NOW.getTime() - STARTING_STALE_MS))
            await wasQueuedAt(analyzing, new Date(NOW.getTime() - STARTING_STALE_MS))
            await lastTouchedAt(queued, new Date(NOW.getTime() - STARTING_STALE_MS - 1))

            await lifecycle.expireStale(USER, NOW)

            expect((await findJob(verifying))?.status).toBe(JobStatus.Verifying)
            expect((await findJob(queued))?.status).toBe(JobStatus.Queued)
            expect((await findJob(analyzing))?.status).toBe(JobStatus.Analyzing)
            expect(await usedRuns()).toBe(2)
        })

        it('gives a job whose Gemini call started 12 minutes from that start, however long ago it was queued', async () => {
            const overdue = await queueJob(NETWORK_CHARGE)
            const running = await queueJob(NETWORK_CHARGE)

            jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
            await wasQueuedAt(overdue, new Date(NOW.getTime() - MODEL_CALL_STALE_MS * 2))
            await wasQueuedAt(running, new Date(NOW.getTime() - MODEL_CALL_STALE_MS * 2))
            await callStartedAt(overdue, new Date(NOW.getTime() - MODEL_CALL_STALE_MS - 1))
            await callStartedAt(running, new Date(NOW.getTime() - MODEL_CALL_STALE_MS))

            await lifecycle.expireStale(USER, NOW)

            expect(await findJob(overdue)).toMatchObject({
                status: JobStatus.Error,
                errorCode: JobErrorCode.AnalysisTimedOut,
                chargedRunId: null,
            })
            expect((await findJob(running))?.status).toBe(JobStatus.Analyzing)
            expect(await usedRuns()).toBe(1)
        })

        it('restarts the start clock when Vertex refused the call, so the retry gets a full window', async () => {
            const jobId = await queueJob()

            jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
            await wasQueuedAt(jobId, new Date(NOW.getTime() - STARTING_STALE_MS - 1))
            await callStartedAt(jobId, NOW)
            await lifecycle.clearModelCall(jobId, NOW)

            await lifecycle.expireStale(USER, new Date(NOW.getTime() + STARTING_STALE_MS))

            expect((await findJob(jobId))?.status).toBe(JobStatus.Analyzing)

            await lifecycle.expireStale(USER, new Date(NOW.getTime() + STARTING_STALE_MS + 1))

            expect((await findJob(jobId))?.errorCode).toBe(JobErrorCode.AnalysisTimedOut)
        })

        it('leaves a job alone whose worker started its call after the sweep found it', async () => {
            const jobId = await queueJob(NETWORK_CHARGE)
            const findJobs = jobs.find.bind(jobs)
            let found: unknown[] = []

            await lifecycle.startAttempt(jobId)
            await wasQueuedAt(jobId, new Date(NOW.getTime() - STARTING_STALE_MS - 1))
            jest.spyOn(jobs, 'find').mockImplementationOnce(((filter: FilterQuery<JobDoc>, projection: object) => ({
                lean: async () => {
                    found = await findJobs(filter, projection).lean()
                    await lifecycle.markModelCall(jobId, NOW)

                    return found
                },
            })) as never)

            await lifecycle.expireStaleJobs(undefined, NOW)

            expect(found).toHaveLength(1)
            expect(await findJob(jobId)).toMatchObject({
                status: JobStatus.Analyzing,
                chargedRunId: expect.any(String),
            })
            expect(await usedRuns()).toBe(1)
        })

        it('records when a job was queued, which starts its analysis time', async () => {
            const before = new Date()
            const jobId = await queueJob()

            expect((await findJob(jobId))?.queuedAt?.getTime()).toBeGreaterThanOrEqual(before.getTime())
        })

        it('times an analysis queued before queuedAt was recorded from its last write', async () => {
            const legacy = await createJob(JobStatus.Queued)
            const recent = await createJob(JobStatus.Analyzing)

            jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
            await lastTouchedAt(legacy, new Date(NOW.getTime() - STARTING_STALE_MS - 1))
            await lastTouchedAt(recent, new Date(NOW.getTime() - STARTING_STALE_MS))

            await lifecycle.expireStale(USER, NOW)

            expect((await findJob(legacy))?.errorCode).toBe(JobErrorCode.AnalysisTimedOut)
            expect((await findJob(recent))?.status).toBe(JobStatus.Analyzing)
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

        it('refunds what a verification that never finished still holds', async () => {
            const jobId = await claimJob()

            jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
            jest.spyOn(jobs, 'findOneAndUpdate').mockImplementationOnce(() => {
                throw new Error('write failed')
            })
            jest.spyOn(quota, 'refund').mockRejectedValueOnce(new Error('user refund failed'))
            await expect(lifecycle.chargeAndQueue(jobId, USER, MEDIA, NETWORK_CHARGE)).rejects.toThrow('write failed')
            // The API instance died before it could end the start.
            await lastTouchedAt(jobId, new Date(NOW.getTime() - VERIFY_STALE_MS - 1))

            await lifecycle.expireStale(USER, NOW)

            expect(await findJob(jobId)).toMatchObject({
                status: JobStatus.Error,
                errorCode: JobErrorCode.VideoCheckFailed,
                chargedRunId: null,
                chargedIpRunId: null,
            })
            expect(await usedRuns()).toBe(0)
            expect(await networkRuns()).toBe(0)
        })

        it('ends a job still pending 6 hours after its creation as UPLOAD_FAILED, however recently touched', async () => {
            const unstarted = await createJob()
            const young = await createJob()

            await createdAt(unstarted, new Date(NOW.getTime() - UNSTARTED_JOB_MS - 1))
            await createdAt(young, new Date(NOW.getTime() - UNSTARTED_JOB_MS))

            await lifecycle.expireStale(USER, NOW)

            expect(await findJob(unstarted)).toMatchObject({
                status: JobStatus.Error,
                errorCode: JobErrorCode.UploadFailed,
            })
            expect((await findJob(young))?.status).toBe(JobStatus.Pending)
        })

        it('leaves an unstarted job alone when it was started after the sweep found it', async () => {
            const jobId = await createJob()

            await lifecycle.claimForVerification(USER, jobId)
            jest.spyOn(jobs, 'find').mockReturnValueOnce({
                lean: async () => [{ _id: new Types.ObjectId(jobId), status: JobStatus.Pending }],
            } as never)

            await lifecycle.expireStaleJobs(undefined, NOW)

            expect((await findJob(jobId))?.status).toBe(JobStatus.Verifying)
        })

        it("ends every user's unstarted jobs in the daily sweep, and counts them", async () => {
            const own = await createJob()
            const othersJob = await createJob(JobStatus.Pending, OTHER_USER)

            await createdAt(own, new Date(NOW.getTime() - UNSTARTED_JOB_MS - 1))
            await createdAt(othersJob, new Date(NOW.getTime() - UNSTARTED_JOB_MS - 1))

            expect(await lifecycle.expireStaleJobs(undefined, NOW)).toEqual({ expired: 2, failed: 0 })
            expect((await findJob(othersJob))?.errorCode).toBe(JobErrorCode.UploadFailed)
        })

        it("only expires the given user's jobs", async () => {
            const othersJob = await createJob(JobStatus.Verifying, OTHER_USER)

            await lastTouchedAt(othersJob, new Date(NOW.getTime() - VERIFY_STALE_MS - 1))

            await lifecycle.expireStale(USER, NOW)

            expect((await findJob(othersJob))?.status).toBe(JobStatus.Verifying)
        })

        it("expires every user's abandoned jobs in the daily sweep, and counts them", async () => {
            const own = await queueJob(NETWORK_CHARGE)
            const othersJob = await createJob(JobStatus.Analyzing, OTHER_USER)

            jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
            await wasQueuedAt(own, new Date(NOW.getTime() - STARTING_STALE_MS - 1))
            await wasQueuedAt(othersJob, new Date(NOW.getTime() - STARTING_STALE_MS - 1))

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
                expect.arrayContaining([JobStatus.Verifying, JobStatus.Error]),
            )
        })
    })

    describe('live updates', () => {
        const jobEvent = (jobId: string, userId = USER) => ({
            channel: getLiveChannel(userId),
            event: LiveEvent.Job,
            data: { id: jobId },
        })

        it("tells the owner's tabs about every status a run goes through", async () => {
            const jobId = await queueJob()

            await lifecycle.startAttempt(jobId)
            await lifecycle.markModelCall(jobId)
            await lifecycle.complete(jobId, ANALYSIS, CALL)

            // verifying, queued, analyzing, analyzed: the call mark changes nothing a tab shows.
            expect(live.events).toEqual(Array.from({ length: 4 }, () => jobEvent(jobId)))
        })

        it('tells them when a run fails, fails to start or expires', async () => {
            const failed = await queueJob()
            const undispatched = await queueJob()
            const unverified = await claimJob()
            const expired = await createJob()

            await createdAt(expired, new Date(NOW.getTime() - UNSTARTED_JOB_MS - 1))
            live.clear()

            await lifecycle.fail(failed, JobErrorCode.AnalysisFailed, 'boom')
            await lifecycle.failDispatch(undispatched)
            await lifecycle.failStart(unverified, JobErrorCode.VideoCheckFailed)
            await lifecycle.expireStale(USER, NOW)

            expect(live.events).toEqual([failed, undispatched, unverified, expired].map((jobId) => jobEvent(jobId)))
        })

        it('tells nobody when nothing changed', async () => {
            const jobId = await createJob()

            await lifecycle.claimForVerification(OTHER_USER, jobId)
            await lifecycle.startAttempt(jobId)
            await lifecycle.fail(jobId, JobErrorCode.AnalysisFailed, 'boom')

            expect(live.events).toEqual([])
        })

        it("tells nobody about a demo job, which has no owner's tabs", async () => {
            const jobId = await createJob(JobStatus.Queued, DEMO_OWNER)

            await lifecycle.startAttempt(jobId)

            expect(live.events).toEqual([])
        })

        it('keeps a status change whose announcement failed', async () => {
            const jobId = await createJob()

            live.failure = new Error('Ably unavailable')
            jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

            expect(await lifecycle.claimForVerification(USER, jobId)).not.toBeNull()
            expect((await findJob(jobId))?.status).toBe(JobStatus.Verifying)
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

        it('refunds in full a job the removed refund cap left holding its charges', async () => {
            const jobId = await queueJob(NETWORK_CHARGE)

            jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
            jest.spyOn(quota, 'refund').mockRejectedValueOnce(new Error('user refund failed'))
            jest.spyOn(ipQuota, 'refund').mockRejectedValueOnce(new Error('network refund failed'))
            await lifecycle.fail(jobId, JobErrorCode.AnalysisFailed, 'malformed')
            await jobs.collection.updateOne({ _id: new Types.ObjectId(jobId) }, { $set: { isRefundCapped: true } })
            await mongo.connection
                .collection<IpQuotaDoc>(IP_QUOTA_COLLECTION)
                .updateOne({ _id: NETWORK_CHARGE.bucketKey }, { $set: { 'runs.$[].isRefundRefused': true } })

            expect(await lifecycle.refundOwedCharges()).toEqual({ refunded: 1, failed: 0 })
            expect(await findJob(jobId)).toMatchObject({ chargedRunId: null, chargedIpRunId: null })
            expect(await usedRuns()).toBe(0)
            expect(await networkRuns()).toBe(0)
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
