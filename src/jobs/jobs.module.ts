import { Module } from '@nestjs/common'
import { AnalysisDispatchModule } from '../analysis/dispatch/analysis-dispatch.module'
import { DatabaseModule } from '../database/database.module'
import { SamplesModule } from '../samples/samples.module'
import { StorageModule } from '../storage/storage.module'
import { JobAnalysisService } from './job-analysis.service'
import { JobStoreModule } from './job-store.module'
import { JobsController } from './jobs.controller'
import { JobsService } from './jobs.service'
import { MediaProber } from './verification/media-prober'
import { VideoVerifier } from './verification/video-verifier.service'

@Module({
    imports: [DatabaseModule, JobStoreModule, StorageModule, AnalysisDispatchModule, SamplesModule],
    controllers: [JobsController],
    providers: [JobsService, JobAnalysisService, VideoVerifier, MediaProber],
})
export class JobsModule {}
