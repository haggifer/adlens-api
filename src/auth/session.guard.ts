import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import type { Request } from 'express'
import { AuthService } from './auth.service'

export interface AuthenticatedRequest extends Request {
    userId: string
}

// Verifies the Better Auth session on every guarded /v1 request; the user id comes from the session, never the body.
@Injectable()
export class SessionGuard implements CanActivate {
    constructor(private readonly auth: AuthService) {}

    async canActivate(ctx: ExecutionContext): Promise<boolean> {
        const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>()
        const userId = await this.auth.getUserId(req.headers)

        if (!userId) {
            throw new UnauthorizedException('Not authenticated')
        }

        req.userId = userId

        return true
    }
}
