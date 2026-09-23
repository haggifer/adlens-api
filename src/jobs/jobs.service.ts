import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import type { CreateJobInput, Job as JobEntity, JobMedia } from 'adlens-shared'
import { isValidObjectId, Model } from 'mongoose'
import { AnalysisLauncher } from '../analysis/analysis-launcher.service'
import { VerifyService } from '../analysis/verify.service'
import { sanitizeFilename, uploadPath } from '../common/paths'
import { QuotaService } from '../quota/quota.service'
import { JOB_MODEL, JobDocument } from '../schemas/job.schema'
import { StorageService } from '../storage/storage.service'

type JobPatch = Partial<Pick<JobEntity, 'status' | 'media' | 'analysis' | 'error' | 'execution'>>

const toEntity = (doc: JobDocument): JobEntity => ({
    id: doc._id.toString(),
    userId: doc.userId,
    status: doc.status,
    settings: doc.settings,
    file: doc.file,
    media: doc.media,
    analysis: doc.analysis,
    error: doc.error,
    execution: doc.execution,
    createdAt: doc.get('createdAt'),
    updatedAt: doc.get('updatedAt'),
})

@Injectable()
export class JobsService {
    constructor(
        @InjectModel(JOB_MODEL) private readonly model: Model<JobDocument>,
        private readonly storage: StorageService,
        private readonly verify: VerifyService,
        private readonly quota: QuotaService,
        private readonly launcher: AnalysisLauncher,
    ) {}

    async create(userId: string, input: CreateJobInput): Promise<{ job: JobEntity; uploadUrl: string }> {
        const timestamp = Date.now()
        const name = sanitizeFilename(input.file.name)
        const path = uploadPath(userId, timestamp, name)
        const doc = await this.model.create({
            userId,
            status: 'pending',
            settings: input.settings,
            file: {
                bucket: this.storage.bucketName,
                path,
                name,
                contentType: input.file.contentType,
                size: input.file.size,
            },
        })
        const uploadUrl = await this.storage.signedUploadUrl(path, input.file.contentType)

        return { job: toEntity(doc), uploadUrl }
    }

    // Quota is consumed only after a successful verification, so a bad upload never costs a run.
    async analyze(userId: string, id: string): Promise<JobEntity> {
        const job = await this.getDoc(userId, id)

        if (job.status !== 'pending') {
            throw new ConflictException('Job is not pending')
        }

        if (!job.file) {
            throw new ConflictException('Job has no uploaded video')
        }

        let media: JobMedia

        try {
            media = await this.verify.verify(job.file)
        } catch (err) {
            await this.storage.delete(job.file.path)
            await this.update(userId, id, {
                status: 'error',
                error: err instanceof Error ? err.message : 'Verification failed',
            })

            throw err
        }

        await this.quota.consume(userId)

        let execution: string | undefined

        try {
            execution = await this.launcher.launch({ userId, jobId: id })
        } catch (err) {
            await this.quota.refund(userId)

            throw err
        }

        return this.update(userId, id, {
            status: 'queued',
            media,
            ...(execution ? { execution } : {}),
        })
    }

    async getDoc(userId: string, id: string): Promise<JobDocument> {
        if (!isValidObjectId(id)) {
            throw new NotFoundException('Job not found')
        }

        const doc = await this.model.findOne({ _id: id, userId })

        if (!doc) {
            throw new NotFoundException('Job not found')
        }

        return doc
    }

    async getEntity(userId: string, id: string): Promise<JobEntity> {
        const doc = await this.getDoc(userId, id)

        return toEntity(doc)
    }

    async list(userId: string): Promise<JobEntity[]> {
        const docs = await this.model.find({ userId }).sort({ createdAt: -1 }).limit(50)

        return docs.map(toEntity)
    }

    async update(userId: string, id: string, patch: JobPatch): Promise<JobEntity> {
        const doc = await this.model.findOneAndUpdate({ _id: id, userId }, { $set: patch }, { new: true })

        if (!doc) {
            throw new NotFoundException('Job not found')
        }

        return toEntity(doc)
    }
}
