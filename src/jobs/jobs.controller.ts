import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Query,
    Req,
    Res,
    UseGuards,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
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
import type { Request, Response } from 'express'
import { SessionGuard } from '../auth/session.guard'
import { CurrentUser } from '../common/current-user.decorator'
import { RequestIpSource } from '../common/ip-source.decorator'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { Env } from '../config/env'
import type { IpSource } from '../ip-quota/client-ip'
import { AnalysisAdmission } from './analysis-admission.service'
import { readFreeRunUserId, writeFreeRunCookie } from './free-run-cookie'
import { JobAnalysisService } from './job-analysis.service'
import { JobsService, type ListJobsQuery, listJobsQuerySchema } from './jobs.service'

@UseGuards(SessionGuard)
@Controller('v1/jobs')
export class JobsController {
    // Secure only over HTTPS: locally the API runs on plain http://localhost.
    private readonly isSecureCookie: boolean

    constructor(
        private readonly jobs: JobsService,
        private readonly analysis: JobAnalysisService,
        private readonly admission: AnalysisAdmission,
        config: ConfigService<Env, true>,
    ) {
        this.isSecureCookie = new URL(config.get('BETTER_AUTH_URL', { infer: true })).protocol === 'https:'
    }

    @Post()
    async create(
        @CurrentUser() userId: string,
        @RequestIpSource() ipSource: IpSource,
        @Req() req: Request,
        @Body(new ZodValidationPipe(createJobInputSchema)) input: CreateJobPayload,
    ): Promise<CreateJobResponse> {
        const freeRunUserId = readFreeRunUserId(req)
        const { hasPassedChallenge } = await this.admission.admit(userId, ipSource, input.challengeToken, freeRunUserId)

        const created = await this.jobs.create(userId, input, hasPassedChallenge)
        await this.analysis.startEarlyWorker(created.job.id)

        return created
    }

    @Post('from-sample')
    async createFromSample(
        @CurrentUser() userId: string,
        @RequestIpSource() ipSource: IpSource,
        @Req() req: Request,
        @Body(new ZodValidationPipe(createSampleJobInputSchema)) input: CreateSampleJobPayload,
    ): Promise<JobResponse> {
        const freeRunUserId = readFreeRunUserId(req)
        const { hasPassedChallenge } = await this.admission.admit(userId, ipSource, input.challengeToken, freeRunUserId)

        const job = await this.jobs.createFromSample(userId, input, hasPassedChallenge)

        return { job }
    }

    @Post(':id/analyze')
    @HttpCode(HttpStatus.ACCEPTED)
    async analyze(
        @CurrentUser() userId: string,
        @Param('id') id: string,
        @RequestIpSource() ipSource: IpSource,
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
    ): Promise<JobResponse> {
        const job = await this.analysis.start(userId, id, ipSource, readFreeRunUserId(req))

        // Any analysis, an account's too, uses up the browser's one analysis before an email is confirmed.
        writeFreeRunCookie(res, userId, this.isSecureCookie)

        return { job }
    }

    // A failed run again, as a new job on the same video, charged as a new run.
    @Post(':id/restart')
    @HttpCode(HttpStatus.ACCEPTED)
    async restart(
        @CurrentUser() userId: string,
        @Param('id') id: string,
        @RequestIpSource() ipSource: IpSource,
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
    ): Promise<JobResponse> {
        const job = await this.analysis.restart(userId, id, ipSource, readFreeRunUserId(req))

        writeFreeRunCookie(res, userId, this.isSecureCookie)

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
