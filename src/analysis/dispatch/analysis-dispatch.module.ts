import { JobsClient } from '@google-cloud/run'
import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Env } from '../../config/env'
import { AnalysisDispatcher } from './analysis-dispatcher'
import { CloudRunDispatcher } from './cloud-run.dispatcher'
import { LocalProcessDispatcher } from './local-process.dispatcher'

const createDispatcher = (config: ConfigService<Env, true>): AnalysisDispatcher => {
    if (config.get('ANALYZE_LOCAL', { infer: true })) {
        return new LocalProcessDispatcher()
    }

    const project = config.get('GOOGLE_CLOUD_PROJECT', { infer: true })
    const region = config.get('GCP_REGION', { infer: true })
    const job = config.get('ANALYZE_JOB_NAME', { infer: true })

    return new CloudRunDispatcher(new JobsClient(), `projects/${project}/locations/${region}/jobs/${job}`)
}

@Module({
    providers: [{ provide: AnalysisDispatcher, inject: [ConfigService], useFactory: createDispatcher }],
    exports: [AnalysisDispatcher],
})
export class AnalysisDispatchModule {}
