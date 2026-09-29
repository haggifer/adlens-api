import type { TokenUsage } from '../../database/job.doc'

// Gemini answered, so the call was billed, but the answer can't be used (cut off, blocked or malformed). It carries
// the answer's tokens so the job records what it cost, and the pipeline retries one at most once.
export class ModelAnswerError extends Error {
    constructor(
        message: string,
        readonly usage: TokenUsage,
        readonly isRetryable = false,
        options?: ErrorOptions,
    ) {
        super(message, options)
    }
}
