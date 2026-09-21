import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'

import { AuthModule } from '../auth/auth.module'
import { QuotaModule } from '../quota/quota.module'
import { PROFILE_MODEL, ProfileSchema } from '../schemas/profile.schema'
import { ProfileController } from './profile.controller'
import { ProfileService } from './profile.service'

@Module({
    imports: [MongooseModule.forFeature([{ name: PROFILE_MODEL, schema: ProfileSchema }]), AuthModule, QuotaModule],
    controllers: [ProfileController],
    providers: [ProfileService],
})
export class ProfileModule {}
