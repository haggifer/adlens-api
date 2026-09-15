import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import type { CreateJobInput, Job as JobEntity } from 'adlens-shared'
import { isValidObjectId, Model } from 'mongoose'

import { sanitizeFilename, uploadPath } from '../common/paths'
import { Job, JobDocument } from '../schemas/job.schema'
import { StorageService } from '../storage/storage.service'

type JobPatch = Partial<Pick<JobEntity, 'status' | 'media' | 'analysis' | 'error'>>

const toEntity = (doc: JobDocument): JobEntity => ({
    id: doc._id.toString(),
    userId: doc.userId,
    status: doc.status,
    settings: doc.settings,
    file: doc.file,
    media: doc.media,
    analysis: doc.analysis,
    error: doc.error,
    createdAt: doc.get('createdAt'),
    updatedAt: doc.get('updatedAt'),
})

@Injectable()
export class JobsService {
    constructor(
        @InjectModel(Job.name) private readonly model: Model<JobDocument>,
        private readonly storage: StorageService,
    ) {}

    async create(userId: string, input: CreateJobInput): Promise<JobEntity> {
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

        return toEntity(doc)
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
