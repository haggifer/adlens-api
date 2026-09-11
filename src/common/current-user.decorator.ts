import { createParamDecorator, ExecutionContext } from '@nestjs/common'

import { AuthenticatedRequest } from '../auth/session.guard'

// Resolves the authenticated user id that SessionGuard attached to the request.
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>()

    return req.userId
})
