import {
    JobErrorCode,
    type JobMedia,
    JobStatus,
    Placement,
    Platform,
    RequestErrorCode,
    VideoMimeType,
} from 'adlens-shared'
import { type Model, Types } from 'mongoose'
import { IP_QUOTA_COLLECTION, IP_QUOTA_MODEL, type IpQuotaDoc, IpQuotaSchema } from '../database/ip-quota.doc'
import { JOB_MODEL, type JobDoc, JobSchema, type StoredJob } from '../database/job.doc'
import { USER_COLLECTION } from '../database/user.doc'
import { IpQuotaService } from '../ip-quota/ip-quota.service'
import type { IpCharge } from '../ip-quota/ip-rules'
import { QuotaService } from '../quota/quota.service'
import { configStub } from '../testing/config-stub'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { JobLifecycle } from './job-lifecycle.service'

const USER = new Types.ObjectId().toString()
const MEDIA: JobMedia = {
    durationS: 12,
    width: 1080,
    height: 1920,
    hasAudio: true,
    sizeBytes: 1000,
    contentType: 'video/mp4',
}
const IP_LIMITS = { IP_ANON_LIMIT: 3, IP_SOFT_LIMIT: 10, IP_HARD_LIMIT: 30 }
const NETWORK_CHARGE: IpCharge = { bucketKey: 'network-key', isAnonymous: false, hasPassedChallenge: false }

describe('JobLifecycle', () => {
    let mongo: MemoryMongo
    let jobs: Model<JobDoc>
    let lifecycle: JobLifecycle

    const users = () => mongo.connection.collection(USER_COLLECTION)
    const used = async () => ((await users().findOne({ _id: new Types.ObjectId(USER) }))?.runs ?? []).length

    const networkRuns = async () =>
        (
            (
                await mongo.connection
                    .collection<IpQuotaDoc>(IP_QUOTA_COLLECTION)
                    .findOne({ _id: NETWORK_CHARGE.bucketKey })
            )?.runs ?? []
        ).length

    const createJob = async (status = JobStatus.Pending): Promise<string> => {
        const job = await jobs.create({
            userId: USER,
            status,
            settings: {
                platforms: [Platform.Meta],
                placements: [Placement.MetaReels],
                markets: [],
                objective: 'Awareness',
            },
            file: { name: 'ad.mp4', contentType: VideoMimeType.Mp4, size: 1000, bucket: 'b', path: 'p' },
            chargedRunId: null,
        })

        return job._id.toString()
    }

    const findJob = (jobId: string) => jobs.findById(jobId).lean<StoredJob>()

    const queueJob = async (ipCharge: IpCharge | null = null): Promise<string> => {
        const jobId = await createJob()

        await lifecycle.claimForVerification(USER, jobId)
        await lifecycle.chargeAndQueue(jobId, USER, MEDIA, ipCharge)

        return jobId
    }

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        jobs = mongo.connection.model<JobDoc>(JOB_MODEL, JobSchema)
        await mongo.connection.model(IP_QUOTA_MODEL, IpQuotaSchema).init()
        lifecycle = new JobLifecycle(
            jobs,
            new QuotaService(mongo.connection, configStub({ QUOTA_LIMIT: 3 })),
            new IpQuotaService(mongo.connection, configStub(IP_LIMITS)),
        )
    })

    beforeEach(async () => {
        await users().insertOne({ _id: new Types.ObjectId(USER), email: 'user@example.com' })
    })

    afterEach(async () => {
        await Promise.all([
            jobs.deleteMany({}),
            users().deleteMany({}),
            mongo.connection.collection(IP_QUOTA_COLLECTION).deleteMany({}),
        ])
    })

    afterAll(async () => {
        await mongo.stop()
    })

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

        expect(await lifecycle.claimForVerification('someone-else', jobId)).toBeNull()
    })

    it('charges one run and records the measured media when queueing', async () => {
        const jobId = await queueJob()
        const job = await findJob(jobId)

        expect(job?.status).toBe(JobStatus.Queued)
        expect(job?.media).toEqual(MEDIA)
        expect(job?.chargedRunId).toEqual(expect.any(String))
        expect(await used()).toBe(1)
    })

    it('refunds a failed run exactly once, even when failure is reported twice', async () => {
        const jobId = await queueJob()
        const results = await Promise.all([
            lifecycle.fail(jobId, JobErrorCode.AnalysisFailed, 'boom'),
            lifecycle.fail(jobId, JobErrorCode.AnalysisFailed, 'boom'),
        ])
        const job = await findJob(jobId)

        expect(results.filter(Boolean)).toHaveLength(1)
        expect(job?.status).toBe(JobStatus.Error)
        expect(job?.errorCode).toBe(JobErrorCode.AnalysisFailed)
        expect(job?.chargedRunId).toBeNull()
        expect(await used()).toBe(0)
    })

    it('puts a job back to pending with the charge refunded when dispatch fails', async () => {
        const jobId = await queueJob()

        await lifecycle.revertDispatch(jobId)

        expect((await findJob(jobId))?.status).toBe(JobStatus.Pending)
        expect(await used()).toBe(0)
    })

    it('starts attempts only for in-flight jobs and counts them', async () => {
        const jobId = await queueJob()

        expect((await lifecycle.startAttempt(jobId))?.attempts).toBe(1)
        expect((await lifecycle.startAttempt(jobId))?.attempts).toBe(2)

        await lifecycle.fail(jobId, JobErrorCode.AnalysisFailed, 'boom')

        expect(await lifecycle.startAttempt(jobId)).toBeNull()
        expect(await lifecycle.startAttempt(new Types.ObjectId().toString())).toBeNull()
    })

    it('keeps a result only while the job is still being analyzed', async () => {
        const jobId = await queueJob()

        expect(await lifecycle.complete(jobId, {} as never, { promptTokens: 1, outputTokens: 1, totalTokens: 2 })).toBe(
            false,
        )
    })

    it('expires abandoned jobs and refunds their charge', async () => {
        const abandoned = await queueJob()
        const stuckVerifying = await createJob(JobStatus.Verifying)
        const past = new Date(Date.now() - 2 * 60 * 60 * 1000)

        await lifecycle.startAttempt(abandoned)
        await jobs.collection.updateMany({}, { $set: { updatedAt: past } })
        await lifecycle.expireStale(USER)

        expect(await findJob(abandoned)).toMatchObject({
            status: JobStatus.Error,
            errorCode: JobErrorCode.AnalysisTimedOut,
        })
        expect((await findJob(stuckVerifying))?.status).toBe(JobStatus.Pending)
        expect(await used()).toBe(0)
    })

    it('charges the network before the user and records both runs', async () => {
        const jobId = await queueJob(NETWORK_CHARGE)
        const job = await findJob(jobId)

        expect(job?.chargedIpRunId).toEqual(expect.any(String))
        expect(await networkRuns()).toBe(1)
        expect(await used()).toBe(1)
    })

    it('gives the network run back when the user has no analyses left', async () => {
        for (let i = 0; i < 3; i++) {
            await queueJob(NETWORK_CHARGE)
        }

        const jobId = await createJob()

        await lifecycle.claimForVerification(USER, jobId)
        await expect(lifecycle.chargeAndQueue(jobId, USER, MEDIA, NETWORK_CHARGE)).rejects.toMatchObject({
            response: { errorCode: RequestErrorCode.QuotaExceeded },
        })
        expect(await networkRuns()).toBe(3)
    })

    it('refunds the network run with the user run, exactly once', async () => {
        const jobId = await queueJob(NETWORK_CHARGE)

        await Promise.all([
            lifecycle.fail(jobId, JobErrorCode.AnalysisFailed, 'boom'),
            lifecycle.fail(jobId, JobErrorCode.AnalysisFailed, 'boom'),
        ])

        expect((await findJob(jobId))?.chargedIpRunId).toBeNull()
        expect(await networkRuns()).toBe(0)
        expect(await used()).toBe(0)
    })
})
