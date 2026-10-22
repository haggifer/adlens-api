import { Injectable, Logger } from '@nestjs/common'
import { JobStatus } from 'adlens-shared'
import { setTimeout as sleep } from 'node:timers/promises'
import { describeError } from '../../common/error-message'
import { EARLY_WORKER_WAIT_MS } from '../../jobs/early-worker'
import { JobLifecycle, type WorkerWait } from '../../jobs/job-lifecycle.service'

type EarlyWorkerState = 'run' | 'waiting' | 'ended' | 'not-left' | 'expired'

export type EarlyWorkerOutcome = Exclude<EarlyWorkerState, 'waiting'>

const POLL_MS = 1000

const FINAL_STATUSES = [JobStatus.Analyzed, JobStatus.Error]
const IN_FLIGHT_STATUSES = [JobStatus.Queued, JobStatus.Analyzing]

// Only the write that queued the job decides whether it is this worker's (leftToEarlyWorker), so this worker never runs
// alongside one the start dispatched; a retry of this worker finds the flag on the job it took and resumes. A pending
// job without a deadline had its dispatch at creation look failed, and the start will dispatch its own worker.
export const checkEarlyWorker = (job: WorkerWait | null, now: Date): EarlyWorkerState => {
    if (!job || FINAL_STATUSES.includes(job.status)) {
        return 'ended'
    }

    if (IN_FLIGHT_STATUSES.includes(job.status)) {
        return job.leftToEarlyWorker ? 'run' : 'not-left'
    }

    if (!job.workerWaitsUntil) {
        return 'not-left'
    }

    return now >= job.workerWaitsUntil ? 'expired' : 'waiting'
}

// The worker dispatched at an upload job's creation waits here, without changing the job, until the job is queued.
// Waiting ends with the process exiting cleanly, so it uses none of Cloud Run's retries: a read that fails is retried
// until the deadline, and only one still failing after it is left to Cloud Run.
@Injectable()
export class EarlyWorkerWait {
    private readonly logger = new Logger(EarlyWorkerWait.name)

    constructor(private readonly lifecycle: JobLifecycle) {}

    async waitForQueue(jobId: string, pollMs = POLL_MS): Promise<EarlyWorkerOutcome> {
        // Until the job is read: its deadline can't be later, since the job was created before this worker started.
        let deadline = new Date(Date.now() + EARLY_WORKER_WAIT_MS)
        let isFailing = false

        for (;;) {
            let state: EarlyWorkerState

            try {
                const job = await this.lifecycle.findWorkerWait(jobId)

                deadline = job?.workerWaitsUntil ?? deadline
                state = checkEarlyWorker(job, new Date())
                isFailing = false
            } catch (err) {
                if (Date.now() >= deadline.getTime()) {
                    throw err
                }

                if (!isFailing) {
                    this.logger.warn(
                        `could not read job ${jobId} while waiting for it, retrying: ${describeError(err)}`,
                    )
                }

                isFailing = true
                state = 'waiting'
            }

            if (state !== 'waiting') {
                return state
            }

            await sleep(pollMs)
        }
    }
}
