import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { AUTH, createAuth } from './auth.instance'
import { AuthService } from './auth.service'
import { SessionGuard } from './session.guard'

@Global()
@Module({
    providers: [
        {
            provide: AUTH,
            inject: [ConfigService],
            useFactory: (config: ConfigService) =>
                createAuth({
                    mongoUri: config.getOrThrow<string>('MONGODB_URI'),
                    secret: config.getOrThrow<string>('BETTER_AUTH_SECRET'),
                    baseURL: config.get<string>('BETTER_AUTH_URL') ?? 'http://localhost:8080',
                    trustedOrigins: (config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000')
                        .split(',')
                        .map((o) => o.trim())
                        .filter(Boolean),
                }),
        },
        AuthService,
        SessionGuard,
    ],
    exports: [AUTH, AuthService, SessionGuard],
})
export class AuthModule {}
