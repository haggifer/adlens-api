import { Controller, Get } from '@nestjs/common'
import type { QuotaResponse } from 'adlens-shared'
import { VISITOR_QUOTA } from '../quota/quota.service'

// Public, so the web can show a visitor without a session what their first analysis allows without hard-coding it.
@Controller('v1/quota')
export class VisitorQuotaController {
    @Get('visitor')
    getVisitorQuota(): QuotaResponse {
        return { quota: VISITOR_QUOTA }
    }
}
