import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { InjectConnection } from '@nestjs/mongoose'
import { Connection, mongo } from 'mongoose'
import type { StoredJob } from '../database/job.doc'
import { toPublicJob } from '../jobs/job.mapper'
import { JobsGateway } from './jobs.gateway'

const RESTART_DELAY_MS = 5 * 1000

// MongoDB can never resume from the token after these: 260 InvalidResumeToken, 280 ChangeStreamFatalError, 286
// ChangeStreamHistoryLost (the oplog rolled past it). Reopening with it would fail every few seconds forever.
const UNRESUMABLE_CODES = new Set([260, 280, 286])

const isUnresumable = (err: Error): boolean => UNRESUMABLE_CODES.has((err as { code?: unknown }).code as number)

// One Change Stream per API instance on the jobs collection: every update is pushed to the owner's socket room. When
// the stream errors (network blip, failover), it is reopened from the last seen resume token, so no update is lost;
// when that token can never be resumed, from now, and a socket that missed an update refetches the job on reconnect.
@Injectable()
export class JobEventsService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(JobEventsService.name)
    private stream?: mongo.ChangeStream
    private resumeToken?: unknown
    private isClosing = false

    constructor(
        @InjectConnection() private readonly conn: Connection,
        private readonly gateway: JobsGateway,
    ) {}

    onModuleInit(): void {
        if (this.conn.readyState === 1) {
            this.watch()
        } else {
            this.conn.once('open', () => this.watch())
        }
    }

    async onModuleDestroy(): Promise<void> {
        this.isClosing = true
        await this.stream?.close()
    }

    private watch(): void {
        const db = this.conn.db

        if (!db) {
            this.logger.error('no database connection available for the change stream')
            return
        }

        this.stream = db.collection('jobs').watch([{ $match: { operationType: { $in: ['update', 'replace'] } } }], {
            fullDocument: 'updateLookup',
            ...(this.resumeToken ? { resumeAfter: this.resumeToken } : {}),
        })

        this.stream.on('change', (change) => {
            this.resumeToken = change._id

            const job = (change as { fullDocument?: StoredJob }).fullDocument

            if (job?.userId) {
                this.gateway.publishJobUpdate(job.userId, toPublicJob(job)).catch((err: unknown) => {
                    this.logger.error(
                        `could not publish job ${job._id.toString()}: ${err instanceof Error ? err.message : err}`,
                    )
                })
            }
        })
        this.stream.on('error', (err: Error) => {
            if (isUnresumable(err)) {
                this.resumeToken = undefined
                this.logger.error(`change stream can't resume, reopening from now: ${err.message}`)
            } else {
                this.logger.error(`change stream error, reopening: ${err.message}`)
            }

            void this.restart()
        })
    }

    private async restart(): Promise<void> {
        await this.stream?.close().catch(() => undefined)

        if (this.isClosing) {
            return
        }

        setTimeout(() => this.watch(), RESTART_DELAY_MS)
    }
}
