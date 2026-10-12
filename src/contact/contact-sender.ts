import { Injectable, Logger } from '@nestjs/common'
import { InjectConnection, InjectModel } from '@nestjs/mongoose'
import type { JobErrorCode, JobStatus, Quota } from 'adlens-shared'
import { type Connection, Model, Types } from 'mongoose'
import type { IncomingHttpHeaders } from 'node:http'
import { AuthService } from '../auth/auth.service'
import { describeError } from '../common/error-message'
import { getUserAccess, USER_ACCESS_PROJECTION, UserAccess } from '../common/user-access'
import { JOB_MODEL, type JobDoc, type StoredJob } from '../database/job.doc'
import { USER_COLLECTION, type UserExtras } from '../database/user.doc'
import { QuotaService } from '../quota/quota.service'
import { describeUserAgent } from './user-agent'

export interface ContactJob {
    id: string
    status: JobStatus
    errorCode?: JobErrorCode
    createdAt: Date
}

export interface ContactAccount {
    id: string
    access: UserAccess
    // The account's own address; null for an anonymous user, whose address is a placeholder.
    email: string | null
    createdAt: Date | null
    quota: Quota
    lastJob: ContactJob | null
}

// What the team sees about whoever wrote, besides the message: the account they were signed in with, if any, and
// their device.
export interface ContactSender {
    account: ContactAccount | null
    device: string | null
    // Set when the account couldn't be read: the message still goes out, saying so.
    lookupError: string | null
}

// Better Auth's own field, next to the ones AdLens reads (UserExtras).
type SenderUserDoc = Pick<UserExtras, '_id' | 'isAdmin' | 'isAnonymous' | 'emailVerified' | 'createdAt'> & {
    email?: string
}

const SENDER_USER_PROJECTION = { ...USER_ACCESS_PROJECTION, email: 1, createdAt: 1 }

@Injectable()
export class ContactSenderReader {
    private readonly logger = new Logger(ContactSenderReader.name)

    constructor(
        @InjectConnection() private readonly connection: Connection,
        @InjectModel(JOB_MODEL) private readonly jobs: Model<JobDoc>,
        private readonly auth: AuthService,
        private readonly quota: QuotaService,
    ) {}

    // Never throws: the facts are for the reader's convenience, and a message must not be lost over them.
    async read(headers: IncomingHttpHeaders): Promise<ContactSender> {
        const device = describeUserAgent(headers['user-agent'])

        try {
            const userId = await this.auth.getUserId(headers)
            const account = userId ? await this.readAccount(userId) : null

            return { account, device, lookupError: null }
        } catch (err) {
            const lookupError = describeError(err)

            this.logger.warn(`could not read a contact sender's account: ${lookupError}`)

            return { account: null, device, lookupError }
        }
    }

    private async readAccount(userId: string): Promise<ContactAccount | null> {
        const [user, quota, lastJob] = await Promise.all([
            this.readUser(userId),
            this.quota.get(userId),
            this.readLastJob(userId),
        ])

        if (!user) {
            return null
        }

        const access = getUserAccess(user)

        return {
            id: userId,
            access,
            email: access === UserAccess.Anonymous ? null : (user.email ?? null),
            createdAt: user.createdAt ?? null,
            quota,
            lastJob,
        }
    }

    private readUser(userId: string): Promise<SenderUserDoc | null> {
        return this.connection
            .collection<SenderUserDoc>(USER_COLLECTION)
            .findOne({ _id: new Types.ObjectId(userId) }, { projection: SENDER_USER_PROJECTION })
    }

    private async readLastJob(userId: string): Promise<ContactJob | null> {
        const job = await this.jobs
            .findOne({ userId }, { status: 1, errorCode: 1, createdAt: 1 })
            .sort({ createdAt: -1 })
            .lean<Pick<StoredJob, '_id' | 'status' | 'errorCode' | 'createdAt'>>()

        return job
            ? { id: job._id.toString(), status: job.status, errorCode: job.errorCode, createdAt: job.createdAt }
            : null
    }
}
