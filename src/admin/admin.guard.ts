import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common'
import { InjectConnection } from '@nestjs/mongoose'
import type { Request } from 'express'
import type { Connection } from 'mongoose'
import { AuthService } from '../auth/auth.service'
import type { AuthenticatedRequest } from '../auth/session.guard'
import { readUserAccess, UserAccess } from '../common/user-access'

// The exception Nest's own not-found handler throws (RoutesResolver.registerNotFoundHandler, with the Express
// adapter's method and originalUrl), so the filter gives a refused request the same status and body as a route that
// doesn't exist, and a probe can't tell the admin routes are there.
const toUnknownRoute = (req: Request) => new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`)

// Lets only admins through, in place of SessionGuard. Admin status is read from the user's document on every request,
// never from the session, so removing `isAdmin` takes effect on the next request.
@Injectable()
export class AdminGuard implements CanActivate {
    constructor(
        private readonly auth: AuthService,
        @InjectConnection() private readonly connection: Connection,
    ) {}

    async canActivate(ctx: ExecutionContext): Promise<boolean> {
        const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>()
        const userId = await this.auth.getUserId(req.headers)

        if (!userId) {
            throw toUnknownRoute(req)
        }

        const access = await readUserAccess(this.connection, userId)

        if (access !== UserAccess.Admin) {
            throw toUnknownRoute(req)
        }

        req.userId = userId

        return true
    }
}
