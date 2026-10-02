import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { DatabaseModule } from '../database/database.module'
import { JobEventsService } from './job-events.service'
import { JobsGateway } from './jobs.gateway'

@Module({
    imports: [AuthModule, DatabaseModule],
    providers: [JobsGateway, JobEventsService],
})
export class RealtimeModule {}
