import { JobStatus } from 'adlens-shared'

// The API is working on a job in these states: it can't be deleted yet, and it can still change without its owner.
export const IN_PROGRESS_STATUSES: JobStatus[] = [JobStatus.Verifying, JobStatus.Queued, JobStatus.Analyzing]

// Far past the signed upload URL's lifetime, and the web starts a run right after its upload: a job still pending this
// long after its creation will never start, and the video of a job not analyzed by then backs no results.
export const UNSTARTED_JOB_MS = 6 * 60 * 60 * 1000
