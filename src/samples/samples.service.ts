import { HttpStatus, Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { RequestErrorCode, type Sample, type SampleListResponse } from 'adlens-shared'
import { isValidObjectId, Model } from 'mongoose'
import { ApiException } from '../common/api-exception'
import { SAMPLE_MODEL, type SampleDoc, type StoredSample } from '../database/sample.doc'
import { StorageService } from '../storage/storage.service'

const notFound = () => new ApiException(HttpStatus.NOT_FOUND, RequestErrorCode.NotFound, 'Sample not found')

@Injectable()
export class SamplesService {
    constructor(
        @InjectModel(SAMPLE_MODEL) private readonly model: Model<SampleDoc>,
        private readonly storage: StorageService,
    ) {}

    // Published samples in display order, each with a short-lived preview URL; storage paths stay server-side.
    async list(): Promise<SampleListResponse> {
        const samples = await this.model.find({ isPublished: true }).sort({ order: 1, _id: 1 }).lean<StoredSample[]>()
        const listed = await Promise.all(samples.map((sample) => this.toPublicSample(sample)))

        return { samples: listed }
    }

    async findPublished(sampleId: string): Promise<StoredSample> {
        if (!isValidObjectId(sampleId)) {
            throw notFound()
        }

        const sample = await this.model.findOne({ _id: sampleId, isPublished: true }).lean<StoredSample>()

        if (!sample) {
            throw notFound()
        }

        return sample
    }

    // The only check a sample job's video gets: a published sample still points at that object.
    async isPublishedPath(path: string): Promise<boolean> {
        const sample = await this.model.exists({ 'file.path': path, isPublished: true })

        return sample !== null
    }

    private async toPublicSample(sample: StoredSample): Promise<Sample> {
        const { url } = await this.storage.createReadUrl(sample.file.path)

        return {
            id: sample._id.toString(),
            title: sample.title,
            description: sample.description,
            settings: sample.settings,
            media: sample.media,
            contentType: sample.file.contentType,
            previewUrl: url,
        }
    }
}
