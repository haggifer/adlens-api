import { JobStatus, VideoMimeType } from 'adlens-shared'
import { type Model, Types } from 'mongoose'
import { JOB_MODEL, type JobDoc, JobSchema, type StoredJob } from '../database/job.doc'
import { USER_COLLECTION } from '../database/user.doc'
import { QuotaService } from '../quota/quota.service'
import type { StorageService } from '../storage/storage.service'
import { configStub } from '../testing/config-stub'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { AccountDataService } from './account-data.service'

const ANONYMOUS = new Types.ObjectId().toString()
const MEMBER = new Types.ObjectId().toString()
const BYSTANDER = new Types.ObjectId().toString()

const fileAt = (path: string) => ({ name: 'ad.mp4', contentType: VideoMimeType.Mp4, size: 1000, bucket: 'b', path })

const run = (id: string) => ({ id, startedAt: new Date(), jobId: `job-${id}` })

describe('AccountDataService', () => {
    let mongo: MemoryMongo
    let jobs: Model<JobDoc>
    let accountData: AccountDataService
    const storage = {
        delete: jest.fn(async (_path: string) => undefined),
        deletePrefix: jest.fn(async (_prefix: string, _keep?: ReadonlySet<string>) => undefined),
    }

    const users = () => mongo.connection.collection(USER_COLLECTION)

    const createJob = async (userId: string, fields: Partial<JobDoc> = {}): Promise<string> => {
        const job = await jobs.create({
            userId,
            status: JobStatus.Analyzed,
            settings: { platforms: [], placements: [], markets: [] },
            file: fileAt(`users/${userId}/jobs/own/video`),
            chargedRunId: null,
            ...fields,
        })

        return job._id.toString()
    }

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        jobs = mongo.connection.model<JobDoc>(JOB_MODEL, JobSchema)
        accountData = new AccountDataService(
            jobs,
            storage as unknown as StorageService,
            new QuotaService(mongo.connection, configStub({ QUOTA_LIMIT: 3 })),
        )
    })

    beforeEach(async () => {
        storage.delete.mockClear()
        storage.deletePrefix.mockClear()
        await users().insertMany([
            {
                _id: new Types.ObjectId(ANONYMOUS),
                email: `${ANONYMOUS}@anonymous.placeholder.invalid`,
                isAnonymous: true,
                runs: [run('anonymous')],
            },
            { _id: new Types.ObjectId(MEMBER), email: 'member@example.com', runs: [run('own')] },
        ])
    })

    afterEach(async () => {
        await Promise.all([jobs.deleteMany({}), users().deleteMany({})])
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it("moves an anonymous user's jobs and runs to their account, and deletes no file", async () => {
        const jobId = await createJob(ANONYMOUS)
        const bystanderJobId = await createJob(BYSTANDER)

        await accountData.adopt(ANONYMOUS, MEMBER)
        await accountData.adopt(ANONYMOUS, MEMBER)

        const member = await users().findOne({ _id: new Types.ObjectId(MEMBER) })
        const job = await jobs.findById(jobId).lean<StoredJob>()

        expect(member?.runs.map((stored: { id: string }) => stored.id).sort()).toEqual(['anonymous', 'own'])
        expect(job?.userId).toBe(MEMBER)
        expect(job?.file.path).toBe(`users/${ANONYMOUS}/jobs/own/video`)
        expect((await jobs.findById(bystanderJobId).lean<StoredJob>())?.userId).toBe(BYSTANDER)
        expect(storage.delete).not.toHaveBeenCalled()
        expect(storage.deletePrefix).not.toHaveBeenCalled()
    })

    it("deletes adopted uploads outside the account's prefix, never a sample video or another user's data", async () => {
        const bystanderJobId = await createJob(BYSTANDER)

        await createJob(MEMBER, { file: fileAt(`users/${ANONYMOUS}/jobs/adopted/video`) })
        await createJob(MEMBER)
        await createJob(MEMBER, { sampleId: 's1', file: fileAt('samples/running-shoes.mp4') })

        await accountData.purge(MEMBER)

        expect(storage.delete.mock.calls).toEqual([[`users/${ANONYMOUS}/jobs/adopted/video`]])
        expect(storage.deletePrefix.mock.calls).toEqual([[`users/${MEMBER}/`, new Set()]])
        expect(await jobs.countDocuments({ userId: MEMBER })).toBe(0)
        expect(await jobs.exists({ _id: bystanderJobId })).not.toBeNull()
    })

    // Better Auth only logs a failed delete of a linked anonymous user, so one can outlive its link; its prefix still
    // holds the videos its jobs took to the account.
    it("keeps the videos another user's jobs still reference when purging a user's prefix", async () => {
        const adoptedPath = `users/${ANONYMOUS}/jobs/adopted/video`

        await createJob(MEMBER, { file: fileAt(adoptedPath) })
        await createJob(ANONYMOUS)

        await accountData.purge(ANONYMOUS)

        expect(storage.deletePrefix.mock.calls).toEqual([[`users/${ANONYMOUS}/`, new Set([adoptedPath])]])
        expect(await jobs.countDocuments({ userId: ANONYMOUS })).toBe(0)
        expect(await jobs.countDocuments({ userId: MEMBER })).toBe(1)
    })
})
