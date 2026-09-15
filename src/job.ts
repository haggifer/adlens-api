import 'reflect-metadata'

import { NestFactory } from '@nestjs/core'

import { AnalysisRunner } from './analysis/analysis-runner.service'
import { JobModule } from './job/job.module'

// Entry point for the on-demand analysis Cloud Run Job. Reads the target job from env overrides set
// by AnalysisLauncher, runs the pipeline once, and exits. No HTTP server — a Cloud Run Job runs to
// completion. Exit codes: 0 success, 1 analysis failure (Cloud Run retries), 2 misconfiguration.
const bootstrap = async () => {
    const userId = process.env.ANALYZE_USER_ID
    const jobId = process.env.ANALYZE_JOB_ID

    if (!userId || !jobId) {
        console.error('ANALYZE_USER_ID and ANALYZE_JOB_ID are required')
        process.exit(2)
    }

    const app = await NestFactory.createApplicationContext(JobModule)

    try {
        await app.get(AnalysisRunner).run(userId, jobId)
        await app.close()
        process.exit(0)
    } catch (err) {
        console.error(`analysis failed for job ${jobId}:`, err)
        await app.close()
        process.exit(1)
    }
}

void bootstrap()
