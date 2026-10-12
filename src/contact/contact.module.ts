import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { getConnectionToken } from '@nestjs/mongoose'
import type { Db } from 'mongodb'
import type { Connection } from 'mongoose'
import { AuthModule } from '../auth/auth.module'
import { ChallengeModule } from '../challenge/challenge.module'
import type { Env } from '../config/env'
import { DatabaseModule } from '../database/database.module'
import { ClientNetworkResolver } from '../ip-quota/client-network.resolver'
import { MailModule } from '../mail/mail.module'
import { QuotaModule } from '../quota/quota.module'
import { StorageModule } from '../storage/storage.module'
import { ContactLimits } from './contact-limits'
import { ContactSenderReader } from './contact-sender'
import { ContactController } from './contact.controller'
import { ContactService } from './contact.service'

const createContactLimits = (connection: Connection, config: ConfigService<Env, true>): ContactLimits => {
    const secret = config.get('BETTER_AUTH_SECRET', { infer: true })

    if (!secret) {
        throw new Error('BETTER_AUTH_SECRET is required: the Contact form counters are keyed with it')
    }

    return new ContactLimits(connection.db as unknown as Db, secret)
}

@Module({
    imports: [DatabaseModule, MailModule, ChallengeModule, StorageModule, AuthModule, QuotaModule],
    controllers: [ContactController],
    providers: [
        ContactService,
        ContactSenderReader,
        ClientNetworkResolver,
        { provide: ContactLimits, inject: [getConnectionToken(), ConfigService], useFactory: createContactLimits },
    ],
})
export class ContactModule {}
