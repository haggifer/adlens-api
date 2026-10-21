import { JobErrorCode, type JobMedia, JobStatus, Market, Platform, VideoMimeType } from 'adlens-shared'
import { type Model, Types } from 'mongoose'
import { JOB_MODEL, type JobDoc, JobSchema, type StoredJob } from '../../database/job.doc'
import { USER_COLLECTION } from '../../database/user.doc'
import { IpQuotaService } from '../../ip-quota/ip-quota.service'
import { EARLY_WORKER_MARGIN_MS } from '../../jobs/early-worker'
import { JobLifecycle } from '../../jobs/job-lifecycle.service'
import { OffLivePublisher } from '../../live/live-publisher'
import { QuotaService } from '../../quota/quota.service'
import { configStub } from '../../testing/config-stub'
import { type MemoryMongo, startMemoryMongo } from '../../testing/memory-mongo'
import { checkEarlyWorker, EarlyWorkerWait } from './early-worker-wait'

const USER = new Types.ObjectId().toString()
const MEDIA: JobMedia = {
    durationS: 15,
    width: 1080,
    height: 1920,
    hasAudio: true,
    sizeBytes: 1000,
    contentType: VideoMimeType.Mp4,
}
const POLL_MS = 10
const NOW = new Date('2026-10-21T10:00:00Z')

const inMs = (ms: number) => new Date(Date.now() + ms)

describe('checkEarlyWorker', () => {
    const deadline = new Date(NOW.getTime() + 1000)

    it('waits for a pending or verifying job until its deadline, then leaves it', () => {
        expect(checkEarlyWorker({ status: JobStatus.Pending, workerWaitsUntil: deadline }, NOW)).toBe('waiting')
        expect(checkEarlyWorker({ status: JobStatus.Verifying, workerWaitsUntil: deadline }, NOW)).toBe('waiting')
        expect(checkEarlyWorker({ status: JobStatus.Verifying, workerWaitsUntil: deadline }, deadline)).toBe('expired')
    })

    it('runs a job in flight that still holds the deadline, whatever the clock says', () => {
        const late = new Date(deadline.getTime() + 1000)

        expect(checkEarlyWorker({ status: JobStatus.Queued, workerWaitsUntil: deadline }, late)).toBe('run')
        expect(checkEarlyWorker({ status: JobStatus.Analyzing, workerWaitsUntil: deadline }, late)).toBe('run')
    })

    it('leaves a job without the deadline, an ended job and a deleted one', () => {
        expect(checkEarlyWorker({ status: JobStatus.Queued }, NOW)).toBe('not-left')
        expect(checkEarlyWorker({ status: JobStatus.Pending }, NOW)).toBe('not-left')
        expect(checkEarlyWorker({ status: JobStatus.Error, workerWaitsUntil: deadline }, NOW)).toBe('ended')
        expect(checkEarlyWorker({ status: JobStatus.Analyzed, workerWaitsUntil: deadline }, NOW)).toBe('ended')
        expect(checkEarlyWorker(null, NOW)).toBe('ended')
    })
})

describe('EarlyWorkerWait', () => {
    let mongo: MemoryMongo
    let jobs: Model<JobDoc>
    let lifecycle: JobLifecycle
    let wait: EarlyWorkerWait

    const users = () => mongo.connection.collection(USER_COLLECTION)

    const createJob = async (workerWaitsUntil?: Date): Promise<string> => {
        const job = await jobs.create({
            userId: USER,
            status: JobStatus.Pending,
            settings: { platforms: [Platform.Meta], placements: [], markets: [Market.EU], objective: 'Conversion' },
            file: { name: 'ad.mp4', contentType: VideoMimeType.Mp4, size: 1000, bucket: 'b', path: 'p' },
            chargedRunId: null,
            chargedIpRunId: null,
            workerWaitsUntil,
        })

        return job._id.toString()
    }

    // As the start does it: the claimed job's deadline decides whether its queueing keeps it.
    const startJob = async (jobId: string) => {
        const claimed = await lifecycle.claimForVerification(USER, jobId)

        await lifecycle.chargeAndQueue(jobId, USER, MEDIA, null, claimed?.workerWaitsUntil)
    }

    const findJob = (jobId: string) => jobs.findById(jobId).lean<StoredJob>()

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        jobs = mongo.connection.model<JobDoc>(JOB_MODEL, JobSchema)
        lifecycle = new JobLifecycle(
            jobs,
            new QuotaService(mongo.connection, configStub({ QUOTA_LIMIT: 3 })),
            new IpQuotaService(
                mongo.connection,
                configStub({ IP_ANON_LIMIT: 3, IP_SOFT_LIMIT: 10, IP_HARD_LIMIT: 30 }),
            ),
            new OffLivePublisher(),
        )
        wait = new EarlyWorkerWait(lifecycle)
    })

    beforeEach(async () => {
        await users().insertOne({ _id: new Types.ObjectId(USER), email: 'user@example.com', emailVerified: true })
    })

    afterEach(async () => {
        await Promise.all([jobs.deleteMany({}), users().deleteMany({})])
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it('waits for the job and runs it once it is queued well before the deadline', async () => {
        const jobId = await createJob(inMs(2 * EARLY_WORKER_MARGIN_MS))
        const waiting = wait.waitForQueue(jobId, POLL_MS)

        await startJob(jobId)

        expect(await waiting).toBe('run')
    })

    it('leaves a job queued within the margin of its deadline to the worker the start dispatched, untouched', async () => {
        const jobId = await createJob(inMs(EARLY_WORKER_MARGIN_MS))

        await startJob(jobId)

        const before = await findJob(jobId)

        expect(await wait.waitForQueue(jobId, POLL_MS)).toBe('not-left')
        expect(await findJob(jobId)).toEqual(before)
    })

    it('resumes a job it already took on a retry', async () => {
        const jobId = await createJob(inMs(2 * EARLY_WORKER_MARGIN_MS))

        await startJob(jobId)
        await lifecycle.startAttempt(jobId)

        expect(await wait.waitForQueue(jobId, POLL_MS)).toBe('run')
    })

    it('leaves a job whose deadline passes while it is pending, untouched', async () => {
        const jobId = await createJob(inMs(5 * POLL_MS))
        const before = await findJob(jobId)

        expect(await wait.waitForQueue(jobId, POLL_MS)).toBe('expired')
        expect(await findJob(jobId)).toEqual(before)
    })

    it('leaves a job that ends or is deleted while it waits', async () => {
        const ended = await createJob(inMs(2 * EARLY_WORKER_MARGIN_MS))
        const deleted = await createJob(inMs(2 * EARLY_WORKER_MARGIN_MS))
        const waitingForEnded = wait.waitForQueue(ended, POLL_MS)
        const waitingForDeleted = wait.waitForQueue(deleted, POLL_MS)

        await lifecycle.claimForVerification(USER, ended)
        await lifecycle.failStart(ended, JobErrorCode.UploadFailed)
        await jobs.deleteOne({ _id: deleted })

        expect(await waitingForEnded).toBe('ended')
        expect(await waitingForDeleted).toBe('ended')
    })

    it('leaves a job whose deadline was cancelled, untouched', async () => {
        const jobId = await createJob()
        const before = await findJob(jobId)

        expect(await wait.waitForQueue(jobId, POLL_MS)).toBe('not-left')
        expect(await findJob(jobId)).toEqual(before)
    })
})
