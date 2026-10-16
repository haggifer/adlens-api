import { Controller, Get, UseGuards } from '@nestjs/common'
import type { LiveTokenResponse } from 'adlens-shared'
import { SessionGuard } from '../auth/session.guard'
import { CurrentUser } from '../common/current-user.decorator'
import { LivePublisher } from './live-publisher'

@UseGuards(SessionGuard)
@Controller('v1/live')
export class LiveController {
    constructor(private readonly live: LivePublisher) {}

    // Ably asks for a new token through the tab before the current one expires, so this runs about once an hour per tab.
    @Get('token')
    async getToken(@CurrentUser() userId: string): Promise<LiveTokenResponse> {
        return { tokenRequest: await this.live.createTokenRequest(userId) }
    }
}
