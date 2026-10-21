// How long the worker dispatched at an upload job's creation waits for the job to be queued. The wait, the worker's
// boot and the 10-minute Gemini request must all fit in the Cloud Run Job's 15-minute task timeout.
export const EARLY_WORKER_WAIT_MS = 3 * 60 * 1000

// The early worker polls about once a second, and its clock may differ from the API's: the job must be queued at least
// this long before the worker's deadline to be left to it.
export const EARLY_WORKER_MARGIN_MS = 15 * 1000

// Whether a job queued at `queuedAt` is left to the worker dispatched at its creation rather than given a new one.
// Decided once, from stored values only, by the write that queues the job, which keeps workerWaitsUntil exactly when
// this holds; the worker reads that field, so the API and the worker never both run the job.
export const isLeftToEarlyWorker = (workerWaitsUntil: Date | undefined, queuedAt: Date): boolean =>
    workerWaitsUntil !== undefined && workerWaitsUntil.getTime() - queuedAt.getTime() > EARLY_WORKER_MARGIN_MS
