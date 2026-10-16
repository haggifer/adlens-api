import { Logger } from '@nestjs/common'
import type { Rest } from 'ably'
import { getLiveChannel, LiveEvent, type LiveJobEvent, type LiveTokenRequest } from 'adlens-shared'
import { describeError } from '../common/error-message'
import { DEMO_OWNER, type StoredJob } from '../database/job.doc'

type JobOwner = Pick<StoredJob, '_id' | 'userId'>

// After a failed publish, publishing waits this long: while Ably is unreachable each publish would hold its write for
// the whole timeout, and a run's start alone publishes four times.
const PAUSE_AFTER_FAILURE_MS = 60 * 1000

// Tells a user's open tabs that their presets or one of their jobs changed, right after the write that changed them.
// A live update is a convenience: a failed publish is logged and never fails the write, whose tabs catch up on their
// next read.
export abstract class LivePublisher {
    private readonly logger = new Logger(LivePublisher.name)

    async publishJob(job: JobOwner): Promise<void> {
        const event: LiveJobEvent = { id: job._id.toString() }

        await this.publish(job.userId, LiveEvent.Job, event)
    }

    async publishPresets(userId: string): Promise<void> {
        await this.publish(userId, LiveEvent.Presets)
    }

    // A token request that lets one tab subscribe to its user's channel and nothing else; null when live updates are
    // off.
    abstract createTokenRequest(userId: string): Promise<LiveTokenRequest | null>

    protected abstract send(channel: string, event: LiveEvent, data?: LiveJobEvent): Promise<void>

    // Demo jobs belong to no user, so nobody listens.
    private async publish(userId: string, event: LiveEvent, data?: LiveJobEvent): Promise<void> {
        if (userId === DEMO_OWNER) {
            return
        }

        try {
            await this.send(getLiveChannel(userId), event, data)
        } catch (err) {
            this.logger.warn(`could not publish ${event} to user ${userId}: ${describeError(err)}`)
        }
    }
}

export class AblyLivePublisher extends LivePublisher {
    private pausedUntil = 0

    constructor(private readonly client: Rest) {
        super()
    }

    // Signed with the key here, without a call to Ably.
    createTokenRequest(userId: string): Promise<LiveTokenRequest> {
        return this.client.auth.createTokenRequest({ capability: { [getLiveChannel(userId)]: ['subscribe'] } })
    }

    protected async send(channel: string, event: LiveEvent, data?: LiveJobEvent): Promise<void> {
        if (Date.now() < this.pausedUntil) {
            return
        }

        try {
            await this.client.channels.get(channel).publish(event, data)
        } catch (err) {
            this.pausedUntil = Date.now() + PAUSE_AFTER_FAILURE_MS

            throw err
        }
    }
}

// Without ABLY_API_KEY: nothing is published and tabs get no token, so they rely on their reads.
export class OffLivePublisher extends LivePublisher {
    createTokenRequest(): Promise<null> {
        return Promise.resolve(null)
    }

    protected send(): Promise<void> {
        return Promise.resolve()
    }
}
