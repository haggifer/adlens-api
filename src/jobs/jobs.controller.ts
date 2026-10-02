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
import { RequestIpSource } from '../common/ip-source.decorator'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { IpSource } from '../ip-quota/client-ip'
import { AnalysisAdmission } from './analysis-admission.service'
import { JobAnalysisService } from './job-analysis.service'
import { JobsService, type ListJobsQuery, listJobsQuerySchema } from './jobs.service'

@UseGuards(SessionGuard)
@Controller('v1/jobs')
export class JobsController {
    constructor(
        private readonly jobs: JobsService,
        private readonly analysis: JobAnalysisService,
        private readonly admission: AnalysisAdmission,
    ) {}

    @Post()
    async create(
        @CurrentUser() userId: string,
        @RequestIpSource() ipSource: IpSource,
        @Body(new ZodValidationPipe(createJobInputSchema)) input: CreateJobPayload,
    ): Promise<CreateJobResponse> {
        const { hasPassedChallenge } = await this.admission.admit(userId, ipSource, input.challengeToken)

        return this.jobs.create(userId, input, hasPassedChallenge)
    }

    @Post('from-sample')
    async createFromSample(
        @CurrentUser() userId: string,
        @RequestIpSource() ipSource: IpSource,
        @Body(new ZodValidationPipe(createSampleJobInputSchema)) input: CreateSampleJobPayload,
    ): Promise<JobResponse> {
        const { hasPassedChallenge } = await this.admission.admit(userId, ipSource, input.challengeToken)

        const job = await this.jobs.createFromSample(userId, input, hasPassedChallenge)

        return { job }
    }

    @Post(':id/analyze')
    @HttpCode(HttpStatus.ACCEPTED)
    async analyze(
        @CurrentUser() userId: string,
        @Param('id') id: string,
        @RequestIpSource() ipSource: IpSource,
    ): Promise<JobResponse> {
        const job = await this.analysis.start(userId, id, ipSource)

        return { job }
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
        const job = await this.jobs.get(userId, id)

        return { job }
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
