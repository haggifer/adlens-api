import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Worker } from 'bullmq'
import IORedis from 'ioredis'

import { ANALYZE_QUEUE, type AnalyzePayload } from '../analysis/analysis.queue'
import { AnalysisRunner } from '../analysis/analysis-runner.service'

// BullMQ consumer (runs in the worker process). Pulls analyze-video jobs and runs the pipeline.
@Injectable()
export class AnalyzeProcessor implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(AnalyzeProcessor.name)
    private worker?: Worker<AnalyzePayload>
    private connection?: IORedis

    constructor(
        private readonly config: ConfigService,
        private readonly runner: AnalysisRunner,
    ) {}

    onModuleInit(): void {
        const url = this.config.getOrThrow<string>('REDIS_URL')
        this.connection = new IORedis(url, { maxRetriesPerRequest: null })

        this.worker = new Worker<AnalyzePayload>(
            ANALYZE_QUEUE,
            async (job) => {
                await this.runner.run(job.data.userId, job.data.jobId)
            },
            { connection: this.connection, concurrency: 4 },
        )

        this.worker.on('failed', (job, err) => this.logger.error(`job ${job?.id} failed: ${err.message}`))
        this.logger.log(`${ANALYZE_QUEUE} worker started`)
    }

    async onModuleDestroy(): Promise<void> {
        await this.worker?.close()
        await this.connection?.quit()
    }
}
