import type { Env } from '../../config/env'

export interface DispatchOptions {
    // Dispatched at the job's creation, before its upload: the worker waits for the job to be queued.
    isEarly?: boolean
    timeoutMs?: number
}

// Tied to the env schema so the names can't drift.
const WORKER_JOB_ID_ENV = 'WORKER_JOB_ID' satisfies keyof Env
const WORKER_IS_EARLY_ENV = 'WORKER_IS_EARLY' satisfies keyof Env

export const getWorkerEnv = (jobId: string, { isEarly = false }: DispatchOptions): Record<string, string> => ({
    [WORKER_JOB_ID_ENV]: jobId,
    ...(isEarly ? { [WORKER_IS_EARLY_ENV]: '1' } : {}),
})

// Starts the worker for a job. Resolves with the runtime's execution name when there is one.
export abstract class AnalysisDispatcher {
    abstract dispatch(jobId: string, options?: DispatchOptions): Promise<string | null>

    // Pays the first dispatch's one-time costs while the API starts; nothing to pay for a local process.
    async warmUp(): Promise<void> {}
}
