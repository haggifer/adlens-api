import { Body, Controller, ForbiddenException, Post } from '@nestjs/common'

import { AuthService } from './auth.service'

// Development-only helper to mint a session token until Better Auth is wired (Phase 1b).
@Controller('v1/auth')
export class AuthController {
    constructor(private readonly auth: AuthService) {}

    @Post('dev-token')
    devToken(@Body() body: { userId?: string }) {
        if (process.env.NODE_ENV === 'production') {
            throw new ForbiddenException('Not available in production')
        }

        const userId = body?.userId || `dev_${Math.random().toString(36).slice(2, 10)}`

        return { userId, token: this.auth.issueDevToken(userId) }
    }
}
