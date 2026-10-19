import { Controller, Get, Header, UseGuards } from '@nestjs/common'
import type { AdminJobsResponse, AdminUsersResponse } from 'adlens-shared'
import { AdminGuard } from './admin.guard'
import { AdminService } from './admin.service'

// Keeps every user's email out of the browser's disk cache. Nest sets it only once AdminGuard passes, so a refusal still
// matches an unknown route.
const NO_STORE = 'no-store'

// Raw records only: the admin page derives counts, costs and user types itself.
@UseGuards(AdminGuard)
@Controller('v1/admin')
export class AdminController {
    constructor(private readonly admin: AdminService) {}

    @Get('jobs')
    @Header('Cache-Control', NO_STORE)
    async listJobs(): Promise<AdminJobsResponse> {
        return { jobs: await this.admin.listJobs() }
    }

    @Get('users')
    @Header('Cache-Control', NO_STORE)
    async listUsers(): Promise<AdminUsersResponse> {
        return { users: await this.admin.listUsers() }
    }
}
