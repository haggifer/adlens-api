import { JobsClient } from '@google-cloud/run'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { AnalysisRunner } from './analysis-runner.service'

export const RUN_JOBS_CLIENT = 'RUN_JOBS_CLIENT'

export interface AnalyzePayload {
    userId: string
    jobId: string
}

// Launches the analysis as an on-demand Cloud Run Job execution through the Cloud Run Admin API,
// passing the target job via env overrides. When ANALYZE_LOCAL=1 it instead runs the pipeline
// in-process (deferred, so the HTTP response returns immediately) so local dev needs no GCP job.
@Injectable()
export class AnalysisLauncher {
    private readonly logger = new Logger(AnalysisLauncher.name)
    private readonly project: string
    private readonly region: string
    private readonly jobName: string
    private readonly local: boolean

    constructor(
        config: ConfigService,
        private readonly runner: AnalysisRunner,
        @Inject(RUN_JOBS_CLIENT) private readonly client: JobsClient,
    ) {
        this.project = config.get<string>('GOOGLE_CLOUD_PROJECT') ?? ''
        this.region = config.get<string>('GCP_REGION') ?? 'europe-west1'
        this.jobName = config.get<string>('ANALYZE_JOB_NAME') ?? 'adlens-analyze'
        this.local = config.get<string>('ANALYZE_LOCAL') === '1'
    }

    async launch(payload: AnalyzePayload): Promise<string | undefined> {
        if (this.local) {
            setImmediate(() => {
                void this.runner.run(payload.userId, payload.jobId).catch((err) => {
                    this.logger.error(
                        `local analysis failed for job ${payload.jobId}: ${err instanceof Error ? err.message : err}`,
                    )
                })
            })

            return undefined
        }

        const name = `projects/${this.project}/locations/${this.region}/jobs/${this.jobName}`
        const [operation] = await this.client.runJob({
            name,
            overrides: {
                containerOverrides: [
                    {
                        env: [
                            { name: 'ANALYZE_USER_ID', value: payload.userId },
                            { name: 'ANALYZE_JOB_ID', value: payload.jobId },
                        ],
                    },
                ],
            },
        })

        const metadata = operation?.metadata as { name?: string } | undefined

        return metadata?.name ?? operation?.name ?? undefined
    }
}
