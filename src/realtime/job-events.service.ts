import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { InjectConnection } from '@nestjs/mongoose'
import type { Job } from 'adlens-shared'
import { Connection, mongo } from 'mongoose'

import { JobsGateway } from './jobs.gateway'

interface JobChangeDoc {
    _id: unknown
    userId: string
    status: Job['status']
    settings: Job['settings']
    file: Job['file']
    media?: Job['media']
    analysis?: Job['analysis']
    error?: string
    createdAt?: Date
    updatedAt?: Date
}

const toEntity = (doc: JobChangeDoc): Job => ({
    id: String(doc._id),
    userId: doc.userId,
    status: doc.status,
    settings: doc.settings,
    file: doc.file ?? null,
    media: doc.media,
    analysis: doc.analysis,
    error: doc.error,
    createdAt: doc.createdAt ?? new Date(),
    updatedAt: doc.updatedAt ?? new Date(),
})

// One Change Stream per API instance on the jobs collection; on each update/replace it pushes the
// fresh job to the owner's socket room. Replaces the Firestore onSnapshot the client used to hold.
@Injectable()
export class JobEventsService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(JobEventsService.name)
    private stream?: mongo.ChangeStream

    constructor(
        @InjectConnection() private readonly conn: Connection,
        private readonly gateway: JobsGateway,
    ) {}

    onModuleInit(): void {
        if (this.conn.readyState === 1) {
            this.startWatch()
        } else {
            this.conn.once('open', () => this.startWatch())
        }
    }

    private startWatch(): void {
        const db = this.conn.db

        if (!db) {
            this.logger.error('no database connection available for the change stream')
            return
        }

        this.stream = db
            .collection('jobs')
            .watch([{ $match: { operationType: { $in: ['update', 'replace'] } } }], { fullDocument: 'updateLookup' })

        this.stream.on('change', (change) => {
            const doc = (change as { fullDocument?: JobChangeDoc }).fullDocument

            if (doc?.userId) {
                this.gateway.emitJobUpdated(doc.userId, toEntity(doc))
            }
        })
        this.stream.on('error', (err: Error) => this.logger.error(`change stream error: ${err.message}`))
        this.logger.log('watching jobs change stream')
    }

    async onModuleDestroy(): Promise<void> {
        await this.stream?.close()
    }
}
