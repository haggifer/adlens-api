import { JobsClient } from '@google-cloud/run'
import { AnalysisDispatcher, type DispatchOptions, getWorkerEnv } from './analysis-dispatcher'

// Runs one execution of the on-demand Cloud Run Job. runJob returns as soon as the execution is created; the worker
// reports progress through the job document, not through this call.
export class CloudRunDispatcher extends AnalysisDispatcher {
    constructor(
        private readonly client: JobsClient,
        private readonly jobName: string,
    ) {
        super()
    }

    // A read of the job itself sets up the client's stubs, its first access token and the gRPC channel, which the first
    // runJob, usually an upload's early dispatch on its short timeout, would otherwise pay.
    override async warmUp(): Promise<void> {
        await this.client.getJob({ name: this.jobName })
    }

    async dispatch(jobId: string, options: DispatchOptions = {}): Promise<string | null> {
        const env = Object.entries(getWorkerEnv(jobId, options)).map(([name, value]) => ({ name, value }))
        const [operation] = await this.client.runJob(
            { name: this.jobName, overrides: { containerOverrides: [{ env }] } },
            options.timeoutMs ? { timeout: options.timeoutMs } : undefined,
        )
        const metadata = operation.metadata as { name?: string } | undefined

        return metadata?.name ?? null
    }
}
