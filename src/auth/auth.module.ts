import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { getConnectionToken } from '@nestjs/mongoose'
import type { Db, MongoClient } from 'mongodb'
import type { Connection } from 'mongoose'
import type { Env } from '../config/env'
import { AUTH, createAuth } from './auth.instance'
import { AuthService } from './auth.service'
import { SessionGuard } from './session.guard'

@Global()
@Module({
    providers: [
        {
            provide: AUTH,
            inject: [ConfigService, getConnectionToken()],
            useFactory: (config: ConfigService<Env, true>, connection: Connection) => {
                const secret = config.get('BETTER_AUTH_SECRET', { infer: true })

                if (!secret) {
                    throw new Error('BETTER_AUTH_SECRET is required')
                }

                // Mongoose bundles its own copy of the driver; the objects are the same at runtime.
                return createAuth({
                    db: connection.db as unknown as Db,
                    client: connection.getClient() as unknown as MongoClient,
                    secret,
                    baseURL: config.get('BETTER_AUTH_URL', { infer: true }),
                    trustedOrigins: [config.get('WEB_ORIGIN', { infer: true })],
                })
            },
        },
        AuthService,
        SessionGuard,
    ],
    exports: [AUTH, AuthService, SessionGuard],
})
export class AuthModule {}
