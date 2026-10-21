import { Module } from '@nestjs/common'
import { JobStoreModule } from '../../jobs/job-store.module'
import { RulesModule } from '../../rules/rules.module'
import { GeminiVideoReviewer } from '../review/gemini-video-reviewer'
import { VideoReviewer } from '../review/video-reviewer'
import { AnalysisPipeline } from './analysis-pipeline.service'
import { EarlyWorkerWait } from './early-worker-wait'

@Module({
    imports: [JobStoreModule, RulesModule],
    providers: [AnalysisPipeline, EarlyWorkerWait, { provide: VideoReviewer, useClass: GeminiVideoReviewer }],
    exports: [AnalysisPipeline, EarlyWorkerWait],
})
export class AnalysisPipelineModule {}
