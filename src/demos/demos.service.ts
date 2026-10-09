import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { type Demo, type DemoListResponse, JobStatus } from 'adlens-shared'
import type { Model } from 'mongoose'
import { DEMO_OWNER, type JobDemo, JOB_MODEL, type JobDoc, type StoredJob } from '../database/job.doc'
import { toPublicJob } from '../jobs/job.mapper'
import { StorageService } from '../storage/storage.service'

type StoredDemoJob = StoredJob & { demo: JobDemo }

// Jobs come newest first within a demo, so the first one per slug is its latest analysis.
const keepLatestPerSlug = (jobs: StoredDemoJob[]): StoredDemoJob[] =>
    jobs.filter((job, index) => jobs.findIndex((other) => other.demo.slug === job.demo.slug) === index)

@Injectable()
export class DemosService {
    constructor(
        @InjectModel(JOB_MODEL) private readonly jobs: Model<JobDoc>,
        private readonly storage: StorageService,
    ) {}

    // The active demos in display order, each with its video's URL (public once moved to the public media bucket). Only a finished analysis is shown, and only
    // the latest per demo: a demo being re-run keeps its earlier job on the page until the new one is done.
    async list(): Promise<DemoListResponse> {
        const jobs = await this.jobs
            .find({ userId: DEMO_OWNER, 'demo.isActive': true, status: JobStatus.Analyzed })
            .sort({ 'demo.order': 1, _id: -1 })
            .lean<StoredDemoJob[]>()
        const demos = await Promise.all(keepLatestPerSlug(jobs).map((job) => this.toDemo(job)))

        return { demos }
    }

    private async toDemo(job: StoredDemoJob): Promise<Demo> {
        const { url } = await this.storage.createFileReadUrl(job.file)
        const { slug, label, title, subtitle } = job.demo

        return { id: job._id.toString(), slug, label, title, subtitle, job: toPublicJob(job), videoUrl: url }
    }
}
