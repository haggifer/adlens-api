import { Injectable } from '@nestjs/common'
import { JobStatus } from 'adlens-shared'
import { setTimeout as sleep } from 'node:timers/promises'
import type { StoredJob } from '../../database/job.doc'
import { JobLifecycle } from '../../jobs/job-lifecycle.service'

type WaitedJob = Pick<StoredJob, 'status' | 'workerWaitsUntil'>

type EarlyWorkerState = 'run' | 'waiting' | 'ended' | 'not-left' | 'expired'

export type EarlyWorkerOutcome = Exclude<EarlyWorkerState, 'waiting'>

const POLL_MS = 1000

const FINAL_STATUSES = [JobStatus.Analyzed, JobStatus.Error]
const IN_FLIGHT_STATUSES = [JobStatus.Queued, JobStatus.Analyzing]

// On a job in flight, workerWaitsUntil survives only when its queueing left the job to this worker, so this worker
// never runs alongside one the start dispatched; a retry of this worker finds it on the job it took and resumes.
// Missing on a job still pending, the dispatch at creation looked failed, and the start will dispatch its own worker.
export const checkEarlyWorker = (job: WaitedJob | null, now: Date): EarlyWorkerState => {
    if (!job || FINAL_STATUSES.includes(job.status)) {
        return 'ended'
    }

    if (!job.workerWaitsUntil) {
        return 'not-left'
    }

    if (IN_FLIGHT_STATUSES.includes(job.status)) {
        return 'run'
    }

    return now >= job.workerWaitsUntil ? 'expired' : 'waiting'
}

// The worker dispatched at an upload job's creation waits here, without changing the job, until the job is queued.
// Waiting ends with the process exiting cleanly, never in a failure, so it uses none of Cloud Run's retries.
@Injectable()
export class EarlyWorkerWait {
    constructor(private readonly lifecycle: JobLifecycle) {}

    async waitForQueue(jobId: string, pollMs = POLL_MS): Promise<EarlyWorkerOutcome> {
        for (;;) {
            const job = await this.lifecycle.findWorkerWait(jobId)
            const state = checkEarlyWorker(job, new Date())

            if (state !== 'waiting') {
                return state
            }

            await sleep(pollMs)
        }
    }
}
