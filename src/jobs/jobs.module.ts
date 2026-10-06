import { Module } from '@nestjs/common'
import { AnalysisDispatchModule } from '../analysis/dispatch/analysis-dispatch.module'
import { ChallengeModule } from '../challenge/challenge.module'
import { DatabaseModule } from '../database/database.module'
import { ClientNetworkResolver } from '../ip-quota/client-network.resolver'
import { IpQuotaModule } from '../ip-quota/ip-quota.module'
import { QuotaModule } from '../quota/quota.module'
import { SamplesModule } from '../samples/samples.module'
import { StorageModule } from '../storage/storage.module'
import { AdmissionController } from './admission.controller'
import { AnalysisAdmission } from './analysis-admission.service'
import { JobAnalysisService } from './job-analysis.service'
import { JobStoreModule } from './job-store.module'
import { JobsController } from './jobs.controller'
import { JobsService } from './jobs.service'
import { MediaProber } from './verification/media-prober'
import { VideoVerifier } from './verification/video-verifier.service'

// ClientNetworkResolver lives here, not in IpQuotaModule: it needs BETTER_AUTH_SECRET, which the worker doesn't have.
@Module({
    imports: [
        DatabaseModule,
        JobStoreModule,
        StorageModule,
        AnalysisDispatchModule,
        SamplesModule,
        QuotaModule,
        IpQuotaModule,
        ChallengeModule,
    ],
    controllers: [JobsController, AdmissionController],
    providers: [JobsService, JobAnalysisService, VideoVerifier, MediaProber, AnalysisAdmission, ClientNetworkResolver],
})
export class JobsModule {}
