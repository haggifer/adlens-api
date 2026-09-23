import { Module } from '@nestjs/common'
import { AuthModule } from './auth/auth.module'
import { appConfigModule } from './config/env'
import { DatabaseModule } from './database/database.module'
import { HealthController } from './health.controller'
import { JobsModule } from './jobs/jobs.module'
import { MeModule } from './me/me.module'
import { RealtimeModule } from './realtime/realtime.module'

// Composition root of the API process (main.ts).
@Module({
    imports: [appConfigModule, DatabaseModule, AuthModule, JobsModule, MeModule, RealtimeModule],
    controllers: [HealthController],
})
export class AppModule {}
