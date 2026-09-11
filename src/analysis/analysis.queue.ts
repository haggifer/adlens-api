import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Queue } from 'bullmq'
import IORedis from 'ioredis'

export const ANALYZE_QUEUE = 'analyze-video'

export interface AnalyzePayload {
    userId: string
    jobId: string
}

// Producer. Uses BullMQ when REDIS_URL is set; otherwise it degrades to a warning so the API still
// boots and the rest of the flow works during local dev without Redis. The worker (consumer) lives in
// its own process (src/worker.ts).
@Injectable()
export class AnalysisQueue implements OnModuleDestroy {
    private readonly logger = new Logger(AnalysisQueue.name)
    private readonly connection: IORedis | null
    private readonly queue: Queue | null

    constructor(config: ConfigService) {
        const url = config.get<string>('REDIS_URL')

        if (url) {
            this.connection = new IORedis(url, { maxRetriesPerRequest: null })
            this.queue = new Queue(ANALYZE_QUEUE, { connection: this.connection })
        } else {
            this.connection = null
            this.queue = null
        }
    }

    async enqueue(payload: AnalyzePayload): Promise<void> {
        if (!this.queue) {
            this.logger.warn(`REDIS_URL not set — not enqueuing ${JSON.stringify(payload)} (worker disabled)`)
            return
        }

        await this.queue.add(ANALYZE_QUEUE, payload, {
            removeOnComplete: true,
            removeOnFail: 50,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
        })
    }

    async onModuleDestroy(): Promise<void> {
        await this.queue?.close()
        await this.connection?.quit()
    }
}
