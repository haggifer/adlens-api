import { Module } from '@nestjs/common'
import { AuthModule } from './auth/auth.module'
import { appConfigModule } from './config/env'
import { ContactModule } from './contact/contact.module'
import { DatabaseModule } from './database/database.module'
import { DemosModule } from './demos/demos.module'
import { HealthController } from './health.controller'
import { JobsModule } from './jobs/jobs.module'
import { MeModule } from './me/me.module'
import { RealtimeModule } from './realtime/realtime.module'
import { SamplesModule } from './samples/samples.module'

@Module({
    imports: [
        appConfigModule,
        DatabaseModule,
        AuthModule,
        JobsModule,
        MeModule,
        RealtimeModule,
        SamplesModule,
        DemosModule,
        ContactModule,
    ],
    controllers: [HealthController],
})
export class AppModule {}
