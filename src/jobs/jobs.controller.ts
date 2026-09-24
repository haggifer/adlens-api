import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common'
import {
    createJobInputSchema,
    type CreateJobPayload,
    type CreateJobResponse,
    createSampleJobInputSchema,
    type CreateSampleJobPayload,
    type JobListResponse,
    type JobResponse,
    type JobVideoResponse,
} from 'adlens-shared'
import { SessionGuard } from '../auth/session.guard'
import { CurrentUser } from '../common/current-user.decorator'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { JobAnalysisService } from './job-analysis.service'
import { JobsService, type ListJobsQuery, listJobsQuerySchema } from './jobs.service'

@UseGuards(SessionGuard)
@Controller('v1/jobs')
export class JobsController {
    constructor(
        private readonly jobs: JobsService,
        private readonly analysis: JobAnalysisService,
    ) {}

    @Post()
    create(
        @CurrentUser() userId: string,
        @Body(new ZodValidationPipe(createJobInputSchema)) input: CreateJobPayload,
    ): Promise<CreateJobResponse> {
        return this.jobs.create(userId, input)
    }

    @Post('from-sample')
    async createFromSample(
        @CurrentUser() userId: string,
        @Body(new ZodValidationPipe(createSampleJobInputSchema)) input: CreateSampleJobPayload,
    ): Promise<JobResponse> {
        return { job: await this.jobs.createFromSample(userId, input) }
    }

    @Post(':id/analyze')
    @HttpCode(HttpStatus.ACCEPTED)
    async analyze(@CurrentUser() userId: string, @Param('id') id: string): Promise<JobResponse> {
        return { job: await this.analysis.start(userId, id) }
    }

    @Get()
    list(
        @CurrentUser() userId: string,
        @Query(new ZodValidationPipe(listJobsQuerySchema)) query: ListJobsQuery,
    ): Promise<JobListResponse> {
        return this.jobs.list(userId, query)
    }

    @Get(':id')
    async getOne(@CurrentUser() userId: string, @Param('id') id: string): Promise<JobResponse> {
        return { job: await this.jobs.get(userId, id) }
    }

    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    remove(@CurrentUser() userId: string, @Param('id') id: string): Promise<void> {
        return this.jobs.remove(userId, id)
    }

    @Get(':id/video')
    video(@CurrentUser() userId: string, @Param('id') id: string): Promise<JobVideoResponse> {
        return this.jobs.createVideoUrl(userId, id)
    }
}
