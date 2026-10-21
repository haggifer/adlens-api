import { AnalysisPipeline } from './analysis-pipeline.service'
import { EarlyWorkerWait } from './early-worker-wait'
import { runWorkerAttempt } from './worker-attempt'

const JOB_ID = 'job-1'

const fakeApp = (waitOutcome: string) => {
    const waitForQueue = jest.fn(async () => waitOutcome)
    const run = jest.fn(async () => 'analyzed')
    const app = {
        get: (token: unknown) => {
            if (token === EarlyWorkerWait) {
                return { waitForQueue }
            }

            if (token === AnalysisPipeline) {
                return { run }
            }

            throw new Error('unexpected provider')
        },
    }

    return { app, waitForQueue, run }
}

describe('runWorkerAttempt', () => {
    it('runs the job at once for a worker the start dispatched, without waiting', async () => {
        const { app, waitForQueue, run } = fakeApp('run')

        await runWorkerAttempt(app as never, JOB_ID, { isEarly: false, isLast: true })

        expect(waitForQueue).not.toHaveBeenCalled()
        expect(run).toHaveBeenCalledWith(JOB_ID, { isLast: true })
    })

    it('runs the job once an early worker is left it', async () => {
        const { app, waitForQueue, run } = fakeApp('run')

        await runWorkerAttempt(app as never, JOB_ID, { isEarly: true, isLast: false })

        expect(waitForQueue).toHaveBeenCalledWith(JOB_ID)
        expect(run).toHaveBeenCalledWith(JOB_ID, { isLast: false })
    })

    it.each(['ended', 'not-left', 'expired'])(
        'never runs the job when an early worker leaves it (%s)',
        async (outcome) => {
            const { app, run } = fakeApp(outcome)

            await expect(runWorkerAttempt(app as never, JOB_ID, { isEarly: true, isLast: false })).resolves.toContain(
                outcome,
            )
            expect(run).not.toHaveBeenCalled()
        },
    )
})
