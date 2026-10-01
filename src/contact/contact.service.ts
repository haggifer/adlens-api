import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { type ContactMessagePayload, RequestErrorCode } from 'adlens-shared'
import { ApiException } from '../common/api-exception'
import type { Env } from '../config/env'
import type { IpSource } from '../ip-quota/client-ip'
import { ClientNetworkResolver } from '../ip-quota/client-network.resolver'
import { Mailer } from '../mail/mailer'
import { contactEmail } from './contact-email'
import { ContactLimits } from './contact-limits'

@Injectable()
export class ContactService {
    private readonly logger = new Logger(ContactService.name)

    constructor(
        private readonly limits: ContactLimits,
        private readonly network: ClientNetworkResolver,
        private readonly mailer: Mailer,
        private readonly config: ConfigService<Env, true>,
    ) {}

    async send(input: ContactMessagePayload, ipSource: IpSource): Promise<void> {
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
        const { bucketKey } = this.network.resolve(ipSource)
        const isAllowed = await this.limits.allowMessage(bucketKey, email)

        if (!isAllowed) {
            throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, RequestErrorCode.RateLimited, 'Too many messages')
        }

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
