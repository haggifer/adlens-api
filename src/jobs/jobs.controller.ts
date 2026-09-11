import { Body, ConflictException, Controller, Get, Param, Post, UseGuards } from '@nestjs/common'
import { createJobInputSchema, type CreateJobInput, type JobMedia } from 'adlens-shared'

import { AnalysisQueue } from '../analysis/analysis.queue'
import { VerifyService } from '../analysis/verify.service'
import { SessionGuard } from '../auth/session.guard'
import { CurrentUser } from '../common/current-user.decorator'
import { ZodBody } from '../common/zod-body.pipe'
import { QuotaService } from '../quota/quota.service'
import { StorageService } from '../storage/storage.service'
import { JobsService } from './jobs.service'

@UseGuards(SessionGuard)
@Controller('v1/jobs')
export class JobsController {
    constructor(
        private readonly jobs: JobsService,
        private readonly quota: QuotaService,
        private readonly verify: VerifyService,
        private readonly queue: AnalysisQueue,
        private readonly storage: StorageService,
    ) {}

    // Create a pending job and hand back a short-lived signed PUT URL for the client to upload the video.
    @Post()
    async create(@CurrentUser() userId: string, @Body(new ZodBody(createJobInputSchema)) input: CreateJobInput) {
        const job = await this.jobs.create(userId, input)
        const uploadUrl = await this.storage.signedUploadUrl(job.file!.path, job.file!.contentType)

        return { job, uploadUrl }
    }

    // Verify the uploaded bytes, consume quota, and enqueue analysis. Quota is spent only after a
    // successful verification, so a bad upload never costs a run.
    @Post(':id/analyze')
    async analyze(@CurrentUser() userId: string, @Param('id') id: string) {
        const job = await this.jobs.getDoc(userId, id)

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
            await this.jobs.update(userId, id, {
                status: 'error',
                error: err instanceof Error ? err.message : 'Verification failed',
            })

            throw err
        }

        await this.quota.consume(userId)

        const updated = await this.jobs.update(userId, id, { status: 'queued', media })
        await this.queue.enqueue({ userId, jobId: id })

        return { job: updated }
    }

    @Get()
    async list(@CurrentUser() userId: string) {
        return { jobs: await this.jobs.list(userId) }
    }

    @Get(':id')
    async getOne(@CurrentUser() userId: string, @Param('id') id: string) {
        return { job: await this.jobs.getEntity(userId, id) }
    }
}
