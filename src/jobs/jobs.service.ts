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
import { SamplesService } from '../samples/samples.service'
import { StorageService } from '../storage/storage.service'
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

const inProgress = () =>
    new ApiException(HttpStatus.CONFLICT, RequestErrorCode.JobInProgress, 'The analysis is still running')

const notFound = () => new ApiException(HttpStatus.NOT_FOUND, RequestErrorCode.NotFound, 'Job not found')

@Injectable()
export class JobsService {
    constructor(
        @InjectModel(JOB_MODEL) private readonly model: Model<JobDoc>,
        private readonly storage: StorageService,
        private readonly lifecycle: JobLifecycle,
        private readonly samples: SamplesService,
    ) {}

    async create(
        userId: string,
        { settings, file }: CreateJobPayload,
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
        { sampleId, settings }: CreateSampleJobPayload,
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
            chargedRunId: null,
            chargedIpRunId: null,
            hasPassedChallenge,
        })

        return toPublicJob(created.toObject<StoredJob>())
    }

    async get(userId: string, jobId: string): Promise<Job> {
        await this.lifecycle.expireStale(userId)

        const job = await this.findOwned(userId, jobId)

        return toPublicJob(job)
    }

    async list(userId: string, { cursor, limit }: ListJobsQuery): Promise<JobListResponse> {
        await this.lifecycle.expireStale(userId)

        const jobs = await this.model
            .find({ userId, ...(cursor ? { _id: { $lt: cursor } } : {}) })
            .sort({ _id: -1 })
            .limit(limit + 1)
            .lean<StoredJob[]>()
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

    // A short-lived URL for replaying the video; only verified uploads have one worth serving.
    async createVideoUrl(userId: string, jobId: string): Promise<JobVideoResponse> {
        const job = await this.findOwned(userId, jobId)

        if (!job.media) {
            throw notFound()
        }

        const { url, expiresAt } = await this.storage.createReadUrl(job.file.path)

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
}
