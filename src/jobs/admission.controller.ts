import { Controller, Get, HttpCode, HttpStatus, Req } from '@nestjs/common'
import type { Request } from 'express'
import { AuthService } from '../auth/auth.service'
import { RequestIpSource } from '../common/ip-source.decorator'
import type { IpSource } from '../ip-quota/client-ip'
import { AnalysisAdmission } from './analysis-admission.service'

// Public, so the web can disable Run before a visitor without a session even has one: 204 when a new analysis would
// be admitted, otherwise the same refusal creating the job would answer.
@Controller('v1/admission')
export class AdmissionController {
    constructor(
        private readonly admission: AnalysisAdmission,
        private readonly auth: AuthService,
    ) {}

    @Get()
    @HttpCode(HttpStatus.NO_CONTENT)
    async check(@Req() req: Request, @RequestIpSource() ipSource: IpSource): Promise<void> {
        const userId = await this.auth.getUserId(req.headers)

        await this.admission.preview(userId, ipSource)
    }
}
