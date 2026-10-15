import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { InjectConnection } from '@nestjs/mongoose'
import { Connection, mongo } from 'mongoose'
import { describeError } from '../common/error-message'
import type { StoredJob } from '../database/job.doc'
import { toPublicJob } from '../jobs/job.mapper'
import { JobsGateway } from './jobs.gateway'

const RESTART_DELAY_MS = 5 * 1000

// MongoDB can never resume from the token after these: 260 InvalidResumeToken, 280 ChangeStreamFatalError, 286
// ChangeStreamHistoryLost (the oplog rolled past it). Reopening with it would fail every few seconds forever.
const UNRESUMABLE_CODES = new Set([260, 280, 286])

// The job fields that change what a client shows. Every other update (a refund, the call mark, an attempt, usage) is
// left out of the stream, so no instance looks it up or publishes it.
const PUBLISHED_FIELDS = ['status', 'analysis', 'errorCode', 'presetId']

export const PUBLISHED_CHANGES = {
    $or: [
        { operationType: 'replace' },
        {
            operationType: 'update',
            $or: PUBLISHED_FIELDS.map((field) => ({ [`updateDescription.updatedFields.${field}`]: { $exists: true } })),
        },
    ],
}

const isUnresumable = (err: Error): boolean => UNRESUMABLE_CODES.has((err as { code?: unknown }).code as number)

// One Change Stream per API instance on the jobs collection: every update is pushed to the owner's socket room. When
// the stream errors (network blip, failover), it is reopened from the last seen resume token, so no update is lost;
// when that token can never be resumed, from now, and a socket that missed an update refetches the job on reconnect.
@Injectable()
export class JobEventsService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(JobEventsService.name)
    private stream?: mongo.ChangeStream
    private resumeToken?: unknown
    private restartTimer?: NodeJS.Timeout
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

    // A restart pending at shutdown would reopen a stream on a connection Nest is closing, and keep the process alive.
    async onModuleDestroy(): Promise<void> {
        this.isClosing = true
        clearTimeout(this.restartTimer)
        await this.stream?.close()
    }

    private watch(): void {
        if (this.isClosing) {
            return
        }

        const db = this.conn.db

        if (!db) {
            this.logger.error('no database connection available for the change stream')
            return
        }

        this.stream = this.openStream(db)
        this.stream.on('change', (change) => this.handleChange(change))
        this.stream.on('error', (err: Error) => this.handleError(err))
    }

    private openStream(db: mongo.Db): mongo.ChangeStream {
        return db.collection('jobs').watch([{ $match: PUBLISHED_CHANGES }], {
            fullDocument: 'updateLookup',
            ...(this.resumeToken ? { resumeAfter: this.resumeToken } : {}),
        })
    }

    private handleChange(change: mongo.ChangeStreamDocument): void {
        this.resumeToken = change._id

        const job = (change as { fullDocument?: StoredJob }).fullDocument

        if (job?.userId) {
            this.gateway.publishJobUpdate(job.userId, toPublicJob(job)).catch((err: unknown) => {
                this.logger.error(`could not publish job ${job._id.toString()}: ${describeError(err)}`)
            })
        }
    }

    private handleError(err: Error): void {
        if (isUnresumable(err)) {
            this.resumeToken = undefined
            this.logger.error(`change stream can't resume, reopening from now: ${err.message}`)
        } else {
            this.logger.error(`change stream error, reopening: ${err.message}`)
        }

        void this.restart()
    }

    private async restart(): Promise<void> {
        await this.stream?.close().catch(() => undefined)

        if (this.isClosing) {
            return
        }

        this.restartTimer = setTimeout(() => this.watch(), RESTART_DELAY_MS)
    }
}
