import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { getConnectionToken } from '@nestjs/mongoose'
import type { Db } from 'mongodb'
import type { Connection } from 'mongoose'
import { ChallengeModule } from '../challenge/challenge.module'
import type { Env } from '../config/env'
import { DatabaseModule } from '../database/database.module'
import { ClientNetworkResolver } from '../ip-quota/client-network.resolver'
import { MailModule } from '../mail/mail.module'
import { ContactLimits } from './contact-limits'
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
    imports: [DatabaseModule, MailModule, ChallengeModule],
    controllers: [ContactController],
    providers: [
        ContactService,
        ClientNetworkResolver,
        { provide: ContactLimits, inject: [getConnectionToken(), ConfigService], useFactory: createContactLimits },
    ],
})
export class ContactModule {}
