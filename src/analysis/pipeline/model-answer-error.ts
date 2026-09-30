import type { ModelCall } from '../../database/job.doc'

// Gemini answered, so the call was billed, but the answer can't be used (cut off, blocked or malformed). It carries
// the call so the job records what it cost, and the pipeline retries one at most once.
export class ModelAnswerError extends Error {
    constructor(
        message: string,
        readonly call: ModelCall,
        readonly isRetryable = false,
        options?: ErrorOptions,
    ) {
        super(message, options)
    }
}
