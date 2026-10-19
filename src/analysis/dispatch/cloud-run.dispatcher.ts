import { JobsClient } from '@google-cloud/run'
import { AnalysisDispatcher, WORKER_JOB_ID_ENV } from './analysis-dispatcher'

// Runs one execution of the on-demand Cloud Run Job. runJob returns as soon as the execution is created; the worker
// reports progress through the job document, not through this call.
export class CloudRunDispatcher extends AnalysisDispatcher {
    constructor(
        private readonly client: JobsClient,
        private readonly jobName: string,
    ) {
        super()
    }

    async dispatch(jobId: string): Promise<string | null> {
        const [operation] = await this.client.runJob({
            name: this.jobName,
            overrides: { containerOverrides: [{ env: [{ name: WORKER_JOB_ID_ENV, value: jobId }] }] },
        })
        const metadata = operation.metadata as { name?: string } | undefined

        return metadata?.name ?? null
    }
}
