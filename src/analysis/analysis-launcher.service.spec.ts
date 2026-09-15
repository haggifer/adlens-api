import { JobsClient } from '@google-cloud/run'
import { ConfigService } from '@nestjs/config'

import { AnalysisLauncher } from './analysis-launcher.service'
import { AnalysisRunner } from './analysis-runner.service'

const configWith = (values: Record<string, string | undefined>): ConfigService =>
    ({ get: (key: string) => values[key] }) as unknown as ConfigService

describe('AnalysisLauncher', () => {
    it('runs the analysis in-process and launches no Cloud Run Job when ANALYZE_LOCAL=1', async () => {
        const run = jest.fn().mockResolvedValue(undefined)
        const runner = { run } as unknown as AnalysisRunner
        const runJob = jest.fn()
        const client = { runJob } as unknown as JobsClient
        const launcher = new AnalysisLauncher(configWith({ ANALYZE_LOCAL: '1' }), runner, client)

        const execution = await launcher.launch({ userId: 'u1', jobId: 'j1' })
        await new Promise((resolve) => setImmediate(resolve))

        expect(execution).toBeUndefined()
        expect(runJob).not.toHaveBeenCalled()
        expect(run).toHaveBeenCalledWith('u1', 'j1')
    })

    it('launches the Cloud Run Job with the correct name and env overrides and returns the execution name', async () => {
        const run = jest.fn()
        const runner = { run } as unknown as AnalysisRunner
        const runJob = jest.fn().mockResolvedValue([{ metadata: { name: 'exec-123' } }])
        const client = { runJob } as unknown as JobsClient
        const launcher = new AnalysisLauncher(
            configWith({ GOOGLE_CLOUD_PROJECT: 'proj', GCP_REGION: 'europe-west1', ANALYZE_JOB_NAME: 'adlens-analyze' }),
            runner,
            client,
        )

        const execution = await launcher.launch({ userId: 'u1', jobId: 'j1' })

        expect(execution).toBe('exec-123')
        expect(run).not.toHaveBeenCalled()
        expect(runJob).toHaveBeenCalledWith({
            name: 'projects/proj/locations/europe-west1/jobs/adlens-analyze',
            overrides: {
                containerOverrides: [
                    {
                        env: [
                            { name: 'ANALYZE_USER_ID', value: 'u1' },
                            { name: 'ANALYZE_JOB_ID', value: 'j1' },
                        ],
                    },
                ],
            },
        })
    })
})
