import { JobStatus, VideoMimeType } from 'adlens-shared'
import { type Model, Types } from 'mongoose'
import { JOB_MODEL, type JobDoc, JobSchema } from '../database/job.doc'
import type { StorageService } from '../storage/storage.service'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { ABANDONED_UPLOAD_MS, AbandonedUploadCleanupService } from './abandoned-upload-cleanup.service'

const NOW = new Date('2026-10-20T03:00:00Z')
const DAY_MS = 24 * 60 * 60 * 1000
const USER = new Types.ObjectId().toString()

const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS)

describe('AbandonedUploadCleanupService', () => {
    let mongo: MemoryMongo
    let jobs: Model<JobDoc>
    let cleanup: AbandonedUploadCleanupService
    const storage = { delete: jest.fn(async (_path: string) => undefined) }

    // Mongoose sets updatedAt itself on create, so the age is written straight to the collection afterwards.
    const createJob = async (updatedDaysAgo: number, fields: Partial<JobDoc> = {}): Promise<string> => {
        const _id = new Types.ObjectId()

        await jobs.create({
            _id,
            userId: USER,
            status: JobStatus.Pending,
            settings: { platforms: [], placements: [], markets: [] },
            file: {
                name: 'ad.mp4',
                contentType: VideoMimeType.Mp4,
                size: 1000,
                bucket: 'b',
                path: `users/${USER}/jobs/${_id}/video`,
            },
            chargedRunId: null,
            chargedIpRunId: null,
            ...fields,
        })
        await jobs.collection.updateOne({ _id }, { $set: { updatedAt: daysAgo(updatedDaysAgo) } })

        return `users/${USER}/jobs/${_id}/video`
    }

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        jobs = mongo.connection.model<JobDoc>(JOB_MODEL, JobSchema)
        cleanup = new AbandonedUploadCleanupService(jobs, storage as unknown as StorageService)
    })

    beforeEach(async () => {
        storage.delete.mockReset()
        storage.delete.mockResolvedValue(undefined)
        await jobs.deleteMany({})
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it('waits a week before calling an upload abandoned', () => {
        expect(ABANDONED_UPLOAD_MS).toBe(7 * DAY_MS)
    })

    it('deletes the video of a job never analyzed for more than a week, and keeps the job', async () => {
        const path = await createJob(8)

        const result = await cleanup.run(NOW)

        expect(result).toEqual({ deleted: 1, failed: 0 })
        expect(storage.delete).toHaveBeenCalledWith(path)
        expect(await jobs.countDocuments()).toBe(1)
    })

    it('keeps the video of a job created or touched within the last week', async () => {
        await createJob(6)

        await cleanup.run(NOW)

        expect(storage.delete).not.toHaveBeenCalled()
    })

    it('keeps the video of every job that went past pending', async () => {
        await createJob(30, { status: JobStatus.Analyzed })
        await createJob(30, { status: JobStatus.Error })

        await cleanup.run(NOW)

        expect(storage.delete).not.toHaveBeenCalled()
    })

    it("never deletes a sample's shared video", async () => {
        await createJob(30, { sampleId: 'sample-1' })

        await cleanup.run(NOW)

        expect(storage.delete).not.toHaveBeenCalled()
    })

    it('goes on after a video that could not be deleted', async () => {
        const failing = await createJob(9)
        const other = await createJob(9)

        storage.delete.mockImplementation(async (path) => {
            if (path === failing) {
                throw new Error('storage unavailable')
            }
        })

        const result = await cleanup.run(NOW)

        expect(result).toEqual({ deleted: 1, failed: 1 })
        expect(storage.delete).toHaveBeenCalledWith(other)
    })
})
