import type { JobsClient } from '@google-cloud/run'
import { CloudRunDispatcher } from './cloud-run.dispatcher'

const JOB_NAME = 'projects/p/locations/r/jobs/adlens-analyze'

const fakeClient = () => {
    const runJob = jest.fn(async (_request: unknown, _options?: unknown) => [{ metadata: { name: 'executions/e-1' } }])
    const getJob = jest.fn(async (_request: unknown) => [{}])

    return { client: { runJob, getJob } as unknown as JobsClient, runJob, getJob }
}

describe('CloudRunDispatcher', () => {
    it("tells the execution its job, and answers the execution's name", async () => {
        const { client, runJob } = fakeClient()

        const execution = await new CloudRunDispatcher(client, JOB_NAME).dispatch('job-1')

        expect(execution).toBe('executions/e-1')
        expect(runJob).toHaveBeenCalledWith(
            {
                name: JOB_NAME,
                overrides: { containerOverrides: [{ env: [{ name: 'WORKER_JOB_ID', value: 'job-1' }] }] },
            },
            undefined,
        )
    })

    it('marks an early execution and bounds how long its dispatch may take', async () => {
        const { client, runJob } = fakeClient()

        await new CloudRunDispatcher(client, JOB_NAME).dispatch('job-1', { isEarly: true, timeoutMs: 4000 })

        expect(runJob).toHaveBeenCalledWith(
            {
                name: JOB_NAME,
                overrides: {
                    containerOverrides: [
                        {
                            env: [
                                { name: 'WORKER_JOB_ID', value: 'job-1' },
                                { name: 'WORKER_IS_EARLY', value: '1' },
                            ],
                        },
                    ],
                },
            },
            { timeout: 4000 },
        )
    })

    it('warms up with a read of the job it runs', async () => {
        const { client, getJob } = fakeClient()

        await new CloudRunDispatcher(client, JOB_NAME).warmUp()

        expect(getJob).toHaveBeenCalledWith({ name: JOB_NAME })
    })
})
