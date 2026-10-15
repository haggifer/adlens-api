import { HttpStatus, Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import {
    type CreateJobPayload,
    type CreateJobResponse,
    type CreateSampleJobPayload,
    type Job,
    type JobListResponse,
    JobStatus,
    type JobVideoResponse,
    RequestErrorCode,
} from 'adlens-shared'
import { isValidObjectId, Model, Types } from 'mongoose'
import { z } from 'zod'
import { ApiException } from '../common/api-exception'
import { jobVideoPath } from '../common/paths'
import { JOB_MODEL, type JobDoc, type StoredJob } from '../database/job.doc'
import { UPLOAD_TOMBSTONE_MODEL, type UploadTombstoneDoc } from '../database/upload-tombstone.doc'
import { SamplesService } from '../samples/samples.service'
import { SIGNED_URL_TTL_MS, StorageService } from '../storage/storage.service'
import { JobLifecycle } from './job-lifecycle.service'
import { IN_PROGRESS_STATUSES } from './job-status'
import { toPublicJob } from './job.mapper'

export const listJobsQuerySchema = z.object({
    cursor: z
        .string()
        .regex(/^[a-f0-9]{24}$/)
        .optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
})

export type ListJobsQuery = z.output<typeof listJobsQuerySchema>

// The upload URL is signed just after the job is created, and an upload that started before it expired may still be
// arriving after it.
const UPLOAD_URL_MARGIN_MS = 60 * 60 * 1000

const inProgress = () =>
    new ApiException(HttpStatus.CONFLICT, RequestErrorCode.JobInProgress, 'The analysis is still running')

const notFound = () => new ApiException(HttpStatus.NOT_FOUND, RequestErrorCode.NotFound, 'Job not found')

@Injectable()
export class JobsService {
    constructor(
        @InjectModel(JOB_MODEL) private readonly model: Model<JobDoc>,
        @InjectModel(UPLOAD_TOMBSTONE_MODEL) private readonly tombstones: Model<UploadTombstoneDoc>,
        private readonly storage: StorageService,
        private readonly lifecycle: JobLifecycle,
        private readonly samples: SamplesService,
    ) {}

    async create(
        userId: string,
        { settings, file, presetId }: CreateJobPayload,
        hasPassedChallenge: boolean,
    ): Promise<CreateJobResponse> {
        const id = new Types.ObjectId()
        const path = jobVideoPath(userId, id.toString())
        const created = await this.model.create({
            _id: id,
            userId,
            status: JobStatus.Pending,
            settings,
            file: { ...file, bucket: this.storage.bucketName, path },
            appliedPresetId: presetId ?? null,
            chargedRunId: null,
            chargedIpRunId: null,
            hasPassedChallenge,
        })
        const upload = await this.storage.createUploadTarget(path, file.contentType, file.size)

        return { job: toPublicJob(created.toObject<StoredJob>()), upload }
    }

    // A pending job on a published sample: its video is already stored and measured, so nothing is uploaded.
    async createFromSample(
        userId: string,
        { sampleId, settings, presetId }: CreateSampleJobPayload,
        hasPassedChallenge: boolean,
    ): Promise<Job> {
        const sample = await this.samples.findPublished(sampleId)
        const created = await this.model.create({
            userId,
            status: JobStatus.Pending,
            settings,
            file: sample.file,
            media: sample.media,
            sampleId: sample._id.toString(),
            appliedPresetId: presetId ?? null,
            chargedRunId: null,
            chargedIpRunId: null,
            hasPassedChallenge,
        })

        return toPublicJob(created.toObject<StoredJob>())
    }

    async recordCountedPreset(jobId: string, presetId: string): Promise<void> {
        await this.model.updateOne({ _id: jobId }, { $set: { presetId } })
    }

    async get(userId: string, jobId: string): Promise<Job> {
        await this.lifecycle.expireStale(userId)

        const job = await this.findOwned(userId, jobId)

        return toPublicJob(job)
    }

    async list(userId: string, { cursor, limit }: ListJobsQuery): Promise<JobListResponse> {
        await this.lifecycle.expireStale(userId)

        const jobs = await this.findPage(userId, cursor, limit + 1)
        const page = jobs.slice(0, limit)

        return {
            jobs: page.map(toPublicJob),
            nextCursor: jobs.length > limit ? page[page.length - 1]._id.toString() : null,
        }
    }

    // Deletes an analysis and, for an upload, its video. A run's quota charge stays spent. The video goes first, so a
    // failed storage call leaves the job in place to retry; a sample's shared video is never deleted. The path decides,
    // not the owner: an adopted job's video stays under the anonymous user's prefix it was uploaded under.
    async remove(userId: string, jobId: string): Promise<void> {
        await this.lifecycle.expireStale(userId)

        const job = await this.findOwned(userId, jobId)

        if (IN_PROGRESS_STATUSES.includes(job.status)) {
            throw inProgress()
        }

        if (!job.sampleId) {
            await this.recordUploadTombstone(job)
            await this.storage.delete(job.file.path)
        }

        const { deletedCount } = await this.model.deleteOne({
            _id: job._id,
            userId,
            status: { $nin: IN_PROGRESS_STATUSES },
        })

        if (!deletedCount) {
            throw inProgress()
        }
    }

    // A short-lived URL for replaying the video; only verified uploads the cleanup hasn't deleted have one worth
    // serving.
    async createVideoUrl(userId: string, jobId: string): Promise<JobVideoResponse> {
        const job = await this.findOwned(userId, jobId)

        if (!job.media || job.videoDeletedAt) {
            throw notFound()
        }

        // A sample job's video is the sample's own object, which may sit in the public media bucket.
        const { url, expiresAt } = await this.storage.createFileReadUrl(job.file)

        return { url, expiresAt: expiresAt.toISOString() }
    }

    async findOwned(userId: string, jobId: string): Promise<StoredJob> {
        if (!isValidObjectId(jobId)) {
            throw notFound()
        }

        const job = await this.model.findOne({ _id: jobId, userId }).lean<StoredJob>()

        if (!job) {
            throw notFound()
        }

        return job
    }

    // The upload URL signed at creation is create-only, so with the object deleted a PUT to it would store a video no
    // job references. Recorded before the delete, so no failure in between can lose it; the cleanup leaves a path
    // that a job still references.
    private async recordUploadTombstone(job: StoredJob, now = new Date()): Promise<void> {
        const deleteAfter = new Date(job.createdAt.getTime() + SIGNED_URL_TTL_MS + UPLOAD_URL_MARGIN_MS)

        if (deleteAfter <= now) {
            return
        }

        await this.tombstones.create({ path: job.file.path, deleteAfter })
    }

    private findPage(userId: string, cursor: string | undefined, limit: number): Promise<StoredJob[]> {
        return this.model
            .find({ userId, ...(cursor ? { _id: { $lt: cursor } } : {}) })
            .sort({ _id: -1 })
            .limit(limit)
            .lean<StoredJob[]>()
    }
}
