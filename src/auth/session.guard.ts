import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import type { Request } from 'express'

import { AuthService } from './auth.service'

export interface AuthenticatedRequest extends Request {
    userId: string
}

// uid comes from the verified token only, never from the request body.
@Injectable()
export class SessionGuard implements CanActivate {
    constructor(private readonly auth: AuthService) {}

    canActivate(ctx: ExecutionContext): boolean {
        const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>()
        const header = req.headers.authorization ?? ''
        const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null

        if (!token) {
            throw new UnauthorizedException('Missing bearer token')
        }

        req.userId = this.auth.verify(token)

        return true
    }
}
