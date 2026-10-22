import type { INestApplicationContext } from '@nestjs/common'
import { AnalysisPipeline } from './analysis-pipeline.service'
import { EarlyWorkerWait } from './early-worker-wait'

interface WorkerAttempt {
    isEarly: boolean
    isLast: boolean
}

// One attempt of the worker process at its job. A worker dispatched at the job's creation waits for the job first and
// runs it only when the job is left to it; any other runs it at once. Answers what became of the job, for the log.
export const runWorkerAttempt = async (
    app: Pick<INestApplicationContext, 'get'>,
    jobId: string,
    { isEarly, isLast }: WorkerAttempt,
): Promise<string> => {
    if (isEarly) {
        const wait = await app.get(EarlyWorkerWait).waitForQueue(jobId)

        if (wait !== 'run') {
            return `left by the worker dispatched at its creation (${wait})`
        }
    }

    return app.get(AnalysisPipeline).run(jobId, { isLast })
}
