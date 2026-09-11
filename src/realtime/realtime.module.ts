import { Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'
import { JobEventsService } from './job-events.service'
import { JobsGateway } from './jobs.gateway'

@Module({
    imports: [AuthModule],
    providers: [JobsGateway, JobEventsService],
})
export class RealtimeModule {}
