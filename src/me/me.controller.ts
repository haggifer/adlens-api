import { Controller, Get, UseGuards } from '@nestjs/common'
import type { QuotaResponse } from 'adlens-shared'
import { SessionGuard } from '../auth/session.guard'
import { CurrentUser } from '../common/current-user.decorator'
import { QuotaService } from '../quota/quota.service'

@UseGuards(SessionGuard)
@Controller('v1/me')
export class MeController {
    constructor(private readonly quota: QuotaService) {}

    @Get('quota')
    async getQuota(@CurrentUser() userId: string): Promise<QuotaResponse> {
        const quota = await this.quota.get(userId)

        return { quota }
    }
}
