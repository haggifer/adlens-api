import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Env } from '../config/env'
import { ConsoleMailer, Mailer, ResendMailer } from './mailer'

const createMailer = (config: ConfigService<Env, true>): Mailer => {
    const apiKey = config.get('RESEND_API_KEY', { infer: true })

    return apiKey ? new ResendMailer(apiKey, config.get('MAIL_FROM', { infer: true })) : new ConsoleMailer()
}

@Module({
    providers: [{ provide: Mailer, inject: [ConfigService], useFactory: createMailer }],
    exports: [Mailer],
})
export class MailModule {}
