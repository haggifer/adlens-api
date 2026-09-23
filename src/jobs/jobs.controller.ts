import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common'
import { createJobInputSchema, type CreateJobInput } from 'adlens-shared'
import { SessionGuard } from '../auth/session.guard'
import { CurrentUser } from '../common/current-user.decorator'
import { ZodBody } from '../common/zod-body.pipe'
import { JobsService } from './jobs.service'

@UseGuards(SessionGuard)
@Controller('v1/jobs')
export class JobsController {
    constructor(private readonly jobs: JobsService) {}

    @Post()
    async create(@CurrentUser() userId: string, @Body(new ZodBody(createJobInputSchema)) input: CreateJobInput) {
        return this.jobs.create(userId, input)
    }

    @Post(':id/analyze')
    @HttpCode(HttpStatus.ACCEPTED)
    async analyze(@CurrentUser() userId: string, @Param('id') id: string) {
        return { job: await this.jobs.analyze(userId, id) }
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
