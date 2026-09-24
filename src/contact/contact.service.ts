import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectModel } from '@nestjs/mongoose'
import { type ContactMessagePayload, RequestErrorCode } from 'adlens-shared'
import { Model } from 'mongoose'
import { ApiException } from '../common/api-exception'
import type { Env } from '../config/env'
import { CONTACT_MESSAGE_MODEL, type ContactMessageDoc } from '../database/contact-message.doc'
import { Mailer } from '../mail/mailer'
import { contactEmail } from './contact-email'

const WINDOW_MS = 60 * 60 * 1000
const MAX_PER_SENDER = 3
// Client IPs can't be trusted behind the proxy, so the hard guarantee against a flooded inbox is a global cap.
const MAX_TOTAL = 20

@Injectable()
export class ContactService {
    private readonly logger = new Logger(ContactService.name)

    constructor(
        @InjectModel(CONTACT_MESSAGE_MODEL) private readonly model: Model<ContactMessageDoc>,
        private readonly mailer: Mailer,
        private readonly config: ConfigService<Env, true>,
    ) {}

    async send(input: ContactMessagePayload): Promise<void> {
        // A bot filled in the hidden field: answer as if it worked, so it learns nothing.
        if (input.website) {
            this.logger.warn('dropped a contact message that filled in the honeypot')
            return
        }

        const to = this.config.get('CONTACT_EMAIL', { infer: true })

        if (!to) {
            throw new ApiException(
                HttpStatus.SERVICE_UNAVAILABLE,
                RequestErrorCode.Unavailable,
                'Contact is not set up',
            )
        }

        const email = input.email.toLowerCase()
        const since = new Date(Date.now() - WINDOW_MS)
        const [total, fromSender] = await Promise.all([
            this.model.countDocuments({ createdAt: { $gte: since } }),
            this.model.countDocuments({ email, createdAt: { $gte: since } }),
        ])

        if (total >= MAX_TOTAL || fromSender >= MAX_PER_SENDER) {
            throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, RequestErrorCode.RateLimited, 'Too many messages')
        }

        await this.model.create({ email })

        try {
            await this.mailer.send(contactEmail(to, { ...input, email }))
        } catch (err) {
            this.logger.error(`could not send a contact message: ${err instanceof Error ? err.message : err}`)
            throw new ApiException(
                HttpStatus.SERVICE_UNAVAILABLE,
                RequestErrorCode.Unavailable,
                'The message could not be sent',
            )
        }
    }
}
