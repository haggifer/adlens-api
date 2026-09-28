import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Env } from '../config/env'
import { ChallengeVerifier, TurnstileVerifier } from './challenge-verifier'

@Module({
    providers: [
        {
            provide: ChallengeVerifier,
            inject: [ConfigService],
            useFactory: (config: ConfigService<Env, true>) =>
                new TurnstileVerifier(config.get('TURNSTILE_SECRET_KEY', { infer: true })),
        },
    ],
    exports: [ChallengeVerifier],
})
export class ChallengeModule {}
