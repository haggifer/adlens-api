import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Env } from '../config/env'
import { Mailer, ResendMailer } from './mailer'

// Only the API sends email, so the key is asserted here rather than in the schema the worker shares.
const createMailer = (config: ConfigService<Env, true>): Mailer => {
    const apiKey = config.get('RESEND_API_KEY', { infer: true })

    if (!apiKey) {
        throw new Error('RESEND_API_KEY is required: the API sends verification, password-reset and Contact emails')
    }

    return new ResendMailer(apiKey, config.get('MAIL_FROM', { infer: true }))
}

@Module({
    providers: [{ provide: Mailer, inject: [ConfigService], useFactory: createMailer }],
    exports: [Mailer],
})
export class MailModule {}
