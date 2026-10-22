// How long the worker dispatched at an upload job's creation waits for the job to be queued. The wait, the worker's
// boot and the 10-minute Gemini request must all fit in the Cloud Run Job's 15-minute task timeout.
export const EARLY_WORKER_WAIT_MS = 3 * 60 * 1000

// The early worker polls about once a second, and its clock may differ from the API's: the job must be queued at least
// this long before the worker's deadline to be left to it.
export const EARLY_WORKER_MARGIN_MS = 15 * 1000

// The upload starts only once POST /v1/jobs answers, and runJob's own timeout is 60 s: a dispatch slower than this is
// given up (the job then gets its worker at start) rather than hold the upload back.
export const EARLY_DISPATCH_TIMEOUT_MS = 4000

// Whether a job queued at `queuedAt` is left to the worker dispatched at its creation rather than given a new one.
// Decided once, from stored values only, by the write that queues the job, which records it as leftToEarlyWorker; the
// start and the worker both read that flag, so they never both run the job.
export const isLeftToEarlyWorker = (workerWaitsUntil: Date | undefined, queuedAt: Date): boolean =>
    workerWaitsUntil !== undefined && workerWaitsUntil.getTime() - queuedAt.getTime() > EARLY_WORKER_MARGIN_MS
