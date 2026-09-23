import { Module } from '@nestjs/common'
import { JobStoreModule } from '../../jobs/job-store.module'
import { RulesModule } from '../../rules/rules.module'
import { GeminiVideoReviewer } from '../review/gemini-video-reviewer'
import { VideoReviewer } from '../review/video-reviewer'
import { AnalysisPipeline } from './analysis-pipeline.service'

@Module({
    imports: [JobStoreModule, RulesModule],
    providers: [AnalysisPipeline, { provide: VideoReviewer, useClass: GeminiVideoReviewer }],
    exports: [AnalysisPipeline],
})
export class AnalysisPipelineModule {}
