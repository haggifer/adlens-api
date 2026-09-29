import { JobStatus } from 'adlens-shared'

// The API is working on a job in these states: it can't be deleted yet, and it can still change without its owner.
export const IN_PROGRESS_STATUSES: JobStatus[] = [JobStatus.Verifying, JobStatus.Queued, JobStatus.Analyzing]
