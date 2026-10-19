import type { Env } from '../../config/env'

// The env var that tells a worker which job to analyze. Tied to the env schema so the two can't drift.
export const WORKER_JOB_ID_ENV = 'WORKER_JOB_ID' satisfies keyof Env

// The run the worker is started for (the job's chargedRunId), so a worker of an earlier run of a restarted job can't
// take over the new one.
export const WORKER_RUN_ID_ENV = 'WORKER_RUN_ID' satisfies keyof Env

// Starts the worker for a queued job. Resolves with the runtime's execution name when there is one.
export abstract class AnalysisDispatcher {
    abstract dispatch(jobId: string, runId: string): Promise<string | null>
}
