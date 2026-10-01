import { Logger } from '@nestjs/common'
import { JobStatus, VideoMimeType } from 'adlens-shared'
import { type Model, Types } from 'mongoose'
import { IP_QUOTA_MODEL, IpQuotaSchema } from '../database/ip-quota.doc'
import { JOB_MODEL, type JobDoc, JobSchema, type StoredJob } from '../database/job.doc'
import { IpQuotaService } from '../ip-quota/ip-quota.service'
import { JobLifecycle } from '../jobs/job-lifecycle.service'
import { IN_PROGRESS_STATUSES } from '../jobs/job-status'
import { QuotaService } from '../quota/quota.service'
import type { StorageService } from '../storage/storage.service'
import { configStub } from '../testing/config-stub'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { AbandonedUploadCleanupService, UNUSED_VIDEO_MS } from './abandoned-upload-cleanup.service'

const NOW = new Date('2026-10-20T03:00:00Z')
const HOUR_MS = 60 * 60 * 1000
const USER = new Types.ObjectId().toString()

const hoursAgo = (hours: number, now = NOW) => new Date(now.getTime() - hours * HOUR_MS)

describe('AbandonedUploadCleanupService', () => {
    let mongo: MemoryMongo
    let jobs: Model<JobDoc>
    let cleanup: AbandonedUploadCleanupService
    const storage = { delete: jest.fn(async (_path: string) => undefined) }

    // Mongoose sets the timestamps itself on create, so the age is written straight to the collection afterwards.
    const createJob = async (createdHoursAgo: number, fields: Partial<JobDoc> = {}, now = NOW) => {
        const _id = new Types.ObjectId()
        const path = `users/${USER}/jobs/${_id}/video`

        await jobs.create({
            _id,
            userId: USER,
            status: JobStatus.Pending,
            settings: { platforms: [], placements: [], markets: [] },
            file: { name: 'ad.mp4', contentType: VideoMimeType.Mp4, size: 1000, bucket: 'b', path },
            chargedRunId: null,
            chargedIpRunId: null,
            ...fields,
        })
        await jobs.collection.updateOne({ _id }, { $set: { createdAt: hoursAgo(createdHoursAgo, now) } })

        return { jobId: _id.toString(), path }
    }

    const findJob = (jobId: string) => jobs.findById(jobId).lean<StoredJob>()

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        jobs = mongo.connection.model<JobDoc>(JOB_MODEL, JobSchema)
        await mongo.connection.model(IP_QUOTA_MODEL, IpQuotaSchema).init()
        cleanup = new AbandonedUploadCleanupService(jobs, storage as unknown as StorageService)
    })

    beforeEach(async () => {
        jest.restoreAllMocks()
        storage.delete.mockReset()
        storage.delete.mockResolvedValue(undefined)
        await jobs.deleteMany({})
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it('waits 6 hours after a job was created', () => {
        expect(UNUSED_VIDEO_MS).toBe(6 * HOUR_MS)
    })

    it.each([JobStatus.Pending, JobStatus.Error])(
        'deletes the video of a %s job created over 6 hours ago, marks it and keeps the job',
        async (status) => {
            const { jobId, path } = await createJob(7, { status })

            const result = await cleanup.run(NOW)

            expect(result).toEqual({ deleted: 1, failed: 0 })
            expect(storage.delete).toHaveBeenCalledWith(path)
            expect((await findJob(jobId))?.videoDeletedAt).toEqual(NOW)
        },
    )

    it('has no upper age bound, so a day the cleanup missed is caught up', async () => {
        await createJob(24 * 90)

        expect(await cleanup.run(NOW)).toEqual({ deleted: 1, failed: 0 })
    })

    it('keeps the video of a job created within the last 6 hours', async () => {
        await createJob(5)

        await cleanup.run(NOW)

        expect(storage.delete).not.toHaveBeenCalled()
    })

    it.each(IN_PROGRESS_STATUSES)(
        'keeps the video of a %s job however old, since it is still running',
        async (status) => {
            await createJob(24 * 30, { status })

            await cleanup.run(NOW)

            expect(storage.delete).not.toHaveBeenCalled()
        },
    )

    it('deletes the video of a job the same run expired, although expiring it just touched it', async () => {
        const now = new Date()
        const quota = new QuotaService(mongo.connection, configStub({ QUOTA_LIMIT: 3 }))
        const ipQuota = new IpQuotaService(mongo.connection, configStub({}))
        const lifecycle = new JobLifecycle(jobs, quota, ipQuota)
        const { jobId, path } = await createJob(7, { status: JobStatus.Analyzing }, now)

        await jobs.collection.updateOne({ _id: new Types.ObjectId(jobId) }, { $set: { updatedAt: hoursAgo(2, now) } })
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

        expect(await lifecycle.expireStaleJobs(undefined, now)).toEqual({ expired: 1, failed: 0 })
        expect(await cleanup.run(now)).toEqual({ deleted: 1, failed: 0 })
        expect(storage.delete).toHaveBeenCalledWith(path)
    })

    it('keeps the video of an analyzed job, which its findings replay', async () => {
        await createJob(24 * 30, { status: JobStatus.Analyzed })

        await cleanup.run(NOW)

        expect(storage.delete).not.toHaveBeenCalled()
    })

    it("never deletes a sample's shared video", async () => {
        await createJob(24 * 30, { sampleId: 'sample-1', status: JobStatus.Error })

        await cleanup.run(NOW)

        expect(storage.delete).not.toHaveBeenCalled()
    })

    it('handles each job once', async () => {
        await createJob(7)

        await cleanup.run(NOW)
        const later = await cleanup.run(new Date(NOW.getTime() + 24 * HOUR_MS))

        expect(later).toEqual({ deleted: 0, failed: 0 })
        expect(storage.delete).toHaveBeenCalledTimes(1)
    })

    it('goes on after a video that could not be deleted, and tries it again the next day', async () => {
        const failing = await createJob(9)
        const other = await createJob(9)

        storage.delete.mockImplementation(async (path) => {
            if (path === failing.path) {
                throw new Error('storage unavailable')
            }
        })

        expect(await cleanup.run(NOW)).toEqual({ deleted: 1, failed: 1 })
        expect(storage.delete).toHaveBeenCalledWith(other.path)
        expect((await findJob(failing.jobId))?.videoDeletedAt).toBeUndefined()
    })
})
