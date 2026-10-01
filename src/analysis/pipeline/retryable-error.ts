// A failure worth another attempt: the provider was busy or unreachable, not wrong about this job.
export class RetryableError extends Error {}

const TRANSIENT_MONGO_ERRORS = new Set(['MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError'])

export const isRetryable = (err: unknown): boolean =>
    err instanceof RetryableError || (err instanceof Error && TRANSIENT_MONGO_ERRORS.has(err.name))
