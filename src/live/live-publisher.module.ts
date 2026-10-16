import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Rest } from 'ably'
import type { Env } from '../config/env'
import { AblyLivePublisher, LivePublisher, OffLivePublisher } from './live-publisher'

// Every publish waits for Ably before the write's request answers (Cloud Run throttles the CPU once it has). Ably checks
// the retry budget only after an attempt fails, so an unreachable Ably holds a write for up to twice this (one attempt,
// one fallback host); LivePublisher then pauses publishing.
const PUBLISH_TIMEOUT_MS = 2 * 1000

const createLivePublisher = (config: ConfigService<Env, true>): LivePublisher => {
    const key = config.get('ABLY_API_KEY', { infer: true })

    if (!key) {
        return new OffLivePublisher()
    }

    return new AblyLivePublisher(
        new Rest({ key, httpRequestTimeout: PUBLISH_TIMEOUT_MS, httpMaxRetryDuration: PUBLISH_TIMEOUT_MS }),
    )
}

// The publisher alone, for every process that writes jobs or presets: the API, the worker and the daily cleanup.
@Module({
    providers: [{ provide: LivePublisher, inject: [ConfigService], useFactory: createLivePublisher }],
    exports: [LivePublisher],
})
export class LivePublisherModule {}
