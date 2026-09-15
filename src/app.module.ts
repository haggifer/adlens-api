import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { MongooseModule } from '@nestjs/mongoose'

import { AuthModule } from './auth/auth.module'
import { HealthController } from './health.controller'
import { JobsModule } from './jobs/jobs.module'
import { ProfileModule } from './profile/profile.module'
import { RealtimeModule } from './realtime/realtime.module'

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
        MongooseModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({ uri: config.getOrThrow<string>('MONGODB_URI') }),
        }),
        AuthModule,
        JobsModule,
        ProfileModule,
        RealtimeModule,
    ],
    controllers: [HealthController],
})
export class AppModule {}
