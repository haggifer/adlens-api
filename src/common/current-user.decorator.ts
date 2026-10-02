import { createParamDecorator, ExecutionContext } from '@nestjs/common'
import { AuthenticatedRequest } from '../auth/session.guard'

// Only defined behind SessionGuard, which attaches the id.
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>()

    return req.userId
})
