import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common'
import { RequestErrorCode } from 'adlens-shared'
import type { AuthenticatedRequest } from '../auth/session.guard'
import { ApiException } from '../common/api-exception'
import { PresetLimits } from './preset-limits'

// After SessionGuard, which attaches the user the limits count for.
@Injectable()
export class PresetLimitGuard implements CanActivate {
    constructor(private readonly limits: PresetLimits) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const { userId, method } = context.switchToHttp().getRequest<AuthenticatedRequest>()
        const isAllowed = await this.limits.allow(userId, method !== 'GET')

        if (!isAllowed) {
            throw new ApiException(
                HttpStatus.TOO_MANY_REQUESTS,
                RequestErrorCode.RateLimited,
                'Too many preset requests',
            )
        }

        return true
    }
}
