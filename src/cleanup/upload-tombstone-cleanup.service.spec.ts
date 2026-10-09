import { Logger } from '@nestjs/common'
import { JobStatus, VideoMimeType } from 'adlens-shared'
import { type Model, Types } from 'mongoose'
import { JOB_MODEL, type JobDoc, JobSchema } from '../database/job.doc'
import {
    UPLOAD_TOMBSTONE_MODEL,
    type UploadTombstoneDoc,
    UploadTombstoneSchema,
} from '../database/upload-tombstone.doc'
import type { StorageService } from '../storage/storage.service'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { UploadTombstoneCleanupService } from './upload-tombstone-cleanup.service'

const NOW = new Date('2026-10-20T03:00:00Z')
const USER = new Types.ObjectId().toString()

const pathOf = (jobId = new Types.ObjectId().toString()) => `users/${USER}/jobs/${jobId}/video`

describe('UploadTombstoneCleanupService', () => {
    let mongo: MemoryMongo
    let jobs: Model<JobDoc>
    let tombstones: Model<UploadTombstoneDoc>
    let cleanup: UploadTombstoneCleanupService
    const storage = { delete: jest.fn(async (_path: string) => undefined) }

    const remaining = async () => (await tombstones.find().lean()).map((tombstone) => tombstone.path)

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        jobs = mongo.connection.model<JobDoc>(JOB_MODEL, JobSchema)
        tombstones = mongo.connection.model<UploadTombstoneDoc>(UPLOAD_TOMBSTONE_MODEL, UploadTombstoneSchema)
        cleanup = new UploadTombstoneCleanupService(tombstones, jobs, storage as unknown as StorageService)
    })

    beforeEach(async () => {
        jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
        storage.delete.mockReset()
        storage.delete.mockResolvedValue(undefined)
        await Promise.all([jobs.deleteMany({}), tombstones.deleteMany({})])
    })

    afterEach(() => {
        jest.restoreAllMocks()
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it('deletes the paths whose upload URL has expired, and keeps the others for a later run', async () => {
        const due = pathOf()
        const notYet = pathOf()

        await tombstones.create([
            { path: due, deleteAfter: NOW },
            { path: notYet, deleteAfter: new Date(NOW.getTime() + 1) },
        ])

        expect(await cleanup.run(NOW)).toEqual({ deleted: 1, failed: 0 })
        expect(storage.delete.mock.calls).toEqual([[due]])
        expect(await remaining()).toEqual([notYet])
    })

    it('keeps a path a job still references, such as one whose deletion failed', async () => {
        const path = pathOf()

        await jobs.create({
            userId: USER,
            status: JobStatus.Error,
            settings: { platforms: [], placements: [], markets: [] },
            file: { name: 'ad.mp4', contentType: VideoMimeType.Mp4, size: 1000, bucket: 'b', path },
            chargedRunId: null,
            chargedIpRunId: null,
        })
        await tombstones.create({ path, deleteAfter: NOW })

        expect(await cleanup.run(NOW)).toEqual({ deleted: 0, failed: 0 })
        expect(storage.delete).not.toHaveBeenCalled()
        expect(await remaining()).toEqual([])
    })

    it('never deletes a path outside the users’ uploads', async () => {
        await tombstones.create({ path: 'samples/running-shoes.mp4', deleteAfter: NOW })

        await cleanup.run(NOW)

        expect(storage.delete).not.toHaveBeenCalled()
    })

    it('counts a path it could not delete and keeps it for the next run', async () => {
        const path = pathOf()

        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
        storage.delete.mockRejectedValueOnce(new Error('GCS 503'))
        await tombstones.create({ path, deleteAfter: NOW })

        expect(await cleanup.run(NOW)).toEqual({ deleted: 0, failed: 1 })
        expect(await remaining()).toEqual([path])
    })
})
