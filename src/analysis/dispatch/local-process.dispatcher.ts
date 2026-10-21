import { Logger } from '@nestjs/common'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { AnalysisDispatcher, type DispatchOptions, getWorkerEnv } from './analysis-dispatcher'

// dist/analysis/dispatch → dist/worker.js
const WORKER_ENTRY = join(__dirname, '..', '..', 'worker.js')

// Local development: runs the same worker entry point as a child process, so the analysis path matches production
// (separate process, same exit semantics) without a Cloud Run Job. There are no retries locally.
export class LocalProcessDispatcher extends AnalysisDispatcher {
    private readonly logger = new Logger(LocalProcessDispatcher.name)

    async dispatch(jobId: string, options: DispatchOptions = {}): Promise<string | null> {
        const worker = spawn(process.execPath, [WORKER_ENTRY], {
            env: {
                ...process.env,
                ...getWorkerEnv(jobId, options),
                CLOUD_RUN_TASK_ATTEMPT: '0',
                ANALYZE_MAX_RETRIES: '0',
            },
            stdio: 'inherit',
        })

        worker.on('error', (err) => this.logger.error(`worker for job ${jobId} failed to start: ${err.message}`))
        worker.on('exit', (code) => this.logger.log(`worker for job ${jobId} exited with ${code}`))

        return null
    }
}
