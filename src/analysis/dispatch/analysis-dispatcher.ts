import type { Env } from '../../config/env'

// The env var that tells a worker which job to analyze. Tied to the env schema so the two can't drift.
export const WORKER_JOB_ID_ENV = 'WORKER_JOB_ID' satisfies keyof Env

// Starts the worker for a queued job. Resolves with the runtime's execution name when there is one.
export abstract class AnalysisDispatcher {
    abstract dispatch(jobId: string): Promise<string | null>
}
