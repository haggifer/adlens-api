import { getLiveChannel, type LiveEvent, type LiveJobEvent, type LiveTokenRequest } from 'adlens-shared'
import { LivePublisher } from '../live/live-publisher'

export interface RecordedLiveEvent {
    channel: string
    event: LiveEvent
    data?: LiveJobEvent
}

// Keeps what would have been published, so tests can tell which writes reach a user's tabs. Set `failure` to make
// every publish reject. Its token requests are unsigned stand-ins that name the channel they would open.
export class RecordingLivePublisher extends LivePublisher {
    readonly events: RecordedLiveEvent[] = []
    failure: Error | null = null

    createTokenRequest(userId: string): Promise<LiveTokenRequest> {
        return Promise.resolve({
            keyName: 'test.key',
            timestamp: 0,
            capability: JSON.stringify({ [getLiveChannel(userId)]: ['subscribe'] }),
            nonce: 'nonce',
            mac: 'mac',
        })
    }

    clear(): void {
        this.events.length = 0
    }

    protected send(channel: string, event: LiveEvent, data?: LiveJobEvent): Promise<void> {
        if (this.failure) {
            return Promise.reject(this.failure)
        }

        this.events.push({ channel, event, ...(data ? { data } : {}) })

        return Promise.resolve()
    }
}
