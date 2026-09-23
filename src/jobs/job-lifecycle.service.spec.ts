import { JobErrorCode, type JobMedia, JobStatus, Placement, Platform, VideoMimeType } from 'adlens-shared'
import { type Model, Types } from 'mongoose'
import { JOB_MODEL, type JobDoc, JobSchema, type StoredJob } from '../database/job.doc'
import { QUOTA_MODEL, type QuotaDoc, QuotaSchema } from '../database/quota.doc'
import { QuotaService } from '../quota/quota.service'
import { configStub } from '../testing/config-stub'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { JobLifecycle } from './job-lifecycle.service'

const USER = 'u1'
const MEDIA: JobMedia = {
    durationS: 12,
    width: 1080,
    height: 1920,
    hasAudio: true,
    sizeBytes: 1000,
    contentType: 'video/mp4',
}

describe('JobLifecycle', () => {
    let mongo: MemoryMongo
    let jobs: Model<JobDoc>
    let quotas: Model<QuotaDoc>
    let lifecycle: JobLifecycle

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
            chargedWindowStart: null,
        })

        return job._id.toString()
    }

    const findJob = (jobId: string) => jobs.findById(jobId).lean<StoredJob>()
    const used = async () => (await quotas.findOne({ userId: USER }).lean())?.used ?? 0

    const queueJob = async (): Promise<string> => {
        const jobId = await createJob()

        await lifecycle.claimForVerification(USER, jobId)
        await lifecycle.chargeAndQueue(jobId, USER, MEDIA)

        return jobId
    }

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        jobs = mongo.connection.model<JobDoc>(JOB_MODEL, JobSchema)
        quotas = mongo.connection.model<QuotaDoc>(QUOTA_MODEL, QuotaSchema)
        lifecycle = new JobLifecycle(jobs, new QuotaService(quotas, configStub({ QUOTA_LIMIT: 3 })))
    })

    afterEach(async () => {
        await Promise.all([jobs.deleteMany({}), quotas.deleteMany({})])
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
        expect(job?.chargedWindowStart).toBeInstanceOf(Date)
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
        expect(job?.chargedWindowStart).toBeNull()
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
})
