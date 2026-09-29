import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { getConnectionToken } from '@nestjs/mongoose'
import type { Db, MongoClient } from 'mongodb'
import type { Connection } from 'mongoose'
import { AccountDataService } from '../account/account-data.service'
import { AccountModule } from '../account/account.module'
import type { Env } from '../config/env'
import { MailModule } from '../mail/mail.module'
import { Mailer } from '../mail/mailer'
import { AuthIndexes } from './auth-indexes'
import { AUTH, createAuth } from './auth.instance'
import { AuthService } from './auth.service'
import { SessionGuard } from './session.guard'
import { toSocialProviders } from './social-providers'

@Global()
@Module({
    imports: [AccountModule, MailModule],
    providers: [
        {
            provide: AUTH,
            inject: [ConfigService, getConnectionToken(), Mailer, AccountDataService],
            useFactory: (
                config: ConfigService<Env, true>,
                connection: Connection,
                mailer: Mailer,
                accountData: AccountDataService,
            ) => {
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
                    webOrigin: config.get('WEB_ORIGIN', { infer: true }),
                    cookieDomain: config.get('COOKIE_DOMAIN', { infer: true }),
                    socialProviders: toSocialProviders({
                        GOOGLE_CLIENT_ID: config.get('GOOGLE_CLIENT_ID', { infer: true }),
                        GOOGLE_CLIENT_SECRET: config.get('GOOGLE_CLIENT_SECRET', { infer: true }),
                        GITHUB_CLIENT_ID: config.get('GITHUB_CLIENT_ID', { infer: true }),
                        GITHUB_CLIENT_SECRET: config.get('GITHUB_CLIENT_SECRET', { infer: true }),
                    }),
                    mailer,
                    onDeleteUser: (userId) => accountData.purge(userId),
                    onLinkAnonymous: (anonymousUserId, userId) => accountData.adopt(anonymousUserId, userId),
                })
            },
        },
        AuthIndexes,
        AuthService,
        SessionGuard,
    ],
    exports: [AUTH, AuthService, SessionGuard],
})
export class AuthModule {}
