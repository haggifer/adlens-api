import { Module } from '@nestjs/common'
import { AnalysisPipelineModule } from './analysis/pipeline/analysis-pipeline.module'
import { appConfigModule } from './config/env'

// Composition root of the analysis worker process (worker.ts). It holds only what the pipeline needs; in particular no
// HTTP layer and no dispatcher, so a worker can never start another worker.
@Module({
    imports: [appConfigModule, AnalysisPipelineModule],
})
export class WorkerModule {}
