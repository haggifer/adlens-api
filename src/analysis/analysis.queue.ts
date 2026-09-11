import { Injectable, Logger } from '@nestjs/common'

export interface AnalyzePayload {
    userId: string
    jobId: string
}

// Phase 1 stub — the real BullMQ producer lands in Phase 2 once Redis is provisioned. Kept behind this
// interface so the analyze route doesn't change when the worker is wired.
@Injectable()
export class AnalysisQueue {
    private readonly logger = new Logger(AnalysisQueue.name)

    async enqueue(payload: AnalyzePayload): Promise<void> {
        this.logger.log(`enqueue analyze-video ${JSON.stringify(payload)} — worker wired in Phase 2 (BullMQ)`)
    }
}
