import type { ModelCall } from '../../database/job.doc'

// Gemini answered, so the call was billed, but the answer can't be used (cut off, blocked or malformed). It carries
// the call so the job records what it cost. Never retried: another attempt would be billed again.
export class ModelAnswerError extends Error {
    constructor(
        message: string,
        readonly call: ModelCall,
        options?: ErrorOptions,
    ) {
        super(message, options)
    }
}

// An earlier attempt at this job started a Gemini call and didn't clear it, so that call may have been billed.
export class ModelCallRepeatedError extends Error {
    constructor() {
        super('An earlier attempt already called the model; it is not called again')
    }
}

// The job ended (the sweep expired it) before this attempt called the model: nothing is left to do.
export class JobEndedError extends Error {
    constructor() {
        super('The job ended before the model was called')
    }
}

// Vertex answered the call with an HTTP error status (e.g. 429, 500, 503) instead of generating, which Gemini doesn't
// bill. Unlike a timeout or a dropped connection, after which Vertex may still have generated a billed answer, the
// call may be made again.
export class ModelCallRefusedError extends Error {
    constructor(
        message: string,
        readonly status: number,
        options?: ErrorOptions,
    ) {
        super(message, options)
    }
}

// A transient refusal reaches the pipeline as the cause of a RetryableError.
export const isRefusedCall = (err: unknown): boolean =>
    err instanceof ModelCallRefusedError || (err instanceof Error && err.cause instanceof ModelCallRefusedError)
