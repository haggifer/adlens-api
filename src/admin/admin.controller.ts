import { Controller, Get, UseGuards } from '@nestjs/common'
import type { AdminJobsResponse, AdminUsersResponse } from 'adlens-shared'
import { AdminGuard } from './admin.guard'
import { AdminService } from './admin.service'

// Raw records only: the admin page derives counts, costs and user types itself.
@UseGuards(AdminGuard)
@Controller('v1/admin')
export class AdminController {
    constructor(private readonly admin: AdminService) {}

    @Get('jobs')
    async listJobs(): Promise<AdminJobsResponse> {
        return { jobs: await this.admin.listJobs() }
    }

    @Get('users')
    async listUsers(): Promise<AdminUsersResponse> {
        return { users: await this.admin.listUsers() }
    }
}
