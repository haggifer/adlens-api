import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common'
import { updateProfileInputSchema, type UpdateProfileInput } from 'adlens-shared'

import { SessionGuard } from '../auth/session.guard'
import { CurrentUser } from '../common/current-user.decorator'
import { ZodBody } from '../common/zod-body.pipe'
import { QuotaService } from '../quota/quota.service'
import { ProfileService } from './profile.service'

@UseGuards(SessionGuard)
@Controller('v1/me')
export class ProfileController {
    constructor(
        private readonly profiles: ProfileService,
        private readonly quota: QuotaService,
    ) {}

    @Get('profile')
    async getProfile(@CurrentUser() userId: string) {
        return { profile: await this.profiles.get(userId) }
    }

    @Patch('profile')
    async updateProfile(
        @CurrentUser() userId: string,
        @Body(new ZodBody(updateProfileInputSchema)) patch: UpdateProfileInput,
    ) {
        return { profile: await this.profiles.update(userId, patch) }
    }

    @Get('quota')
    async getQuota(@CurrentUser() userId: string) {
        return { quota: await this.quota.get(userId) }
    }
}
