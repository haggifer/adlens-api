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
