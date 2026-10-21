import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { runWorkerAttempt } from './analysis/pipeline/worker-attempt'
import { createLogger } from './common/cloud-logger'
import { describeErrorWithStack } from './common/error-message'
import type { Env } from './config/env'
import { readLogFormat } from './config/log-format'
import { WorkerModule } from './worker.module'

const EXIT_DONE = 0
const EXIT_RETRY = 1

// Entry point of the on-demand analysis Cloud Run Job: analyzes the job named by WORKER_JOB_ID once and exits. Exit 1
// asks Cloud Run for a retry (a transient failure before the last attempt); every other outcome, including a failed
// job, exits 0 because the job document already records it.
const run = async (): Promise<number> => {
    const logger = new Logger('Worker')
    const app = await NestFactory.createApplicationContext(WorkerModule, {
        logger: createLogger(readLogFormat(process.env)),
    })
    const config = app.get<ConfigService<Env, true>>(ConfigService)
    const jobId = config.get('WORKER_JOB_ID', { infer: true })
    const attempt = config.get('CLOUD_RUN_TASK_ATTEMPT', { infer: true })
    const maxRetries = config.get('ANALYZE_MAX_RETRIES', { infer: true })
    const isEarly = config.get('WORKER_IS_EARLY', { infer: true })

    try {
        if (!jobId) {
            logger.error('WORKER_JOB_ID is not set; nothing to analyze')
            return EXIT_DONE
        }

        const outcome = await runWorkerAttempt(app, jobId, { isEarly, isLast: attempt >= maxRetries })

        logger.log(`job ${jobId}: ${outcome} (attempt ${attempt})`)

        return EXIT_DONE
    } catch (err) {
        // Anything that escapes the pipeline (it failed before claiming the job, or transiently) must be visible: locally
        // nothing retries, so without this line the job just sits queued until it expires.
        logger.error(`job ${jobId} attempt ${attempt} failed: ${describeErrorWithStack(err)}`)
        return EXIT_RETRY
    } finally {
        await app.close()
    }
}

void run()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
        // Startup failed (config, database connection, module wiring) before the job could be looked at.
        new Logger('Worker').error(`worker failed to start: ${describeErrorWithStack(err)}`)
        process.exit(EXIT_RETRY)
    })
