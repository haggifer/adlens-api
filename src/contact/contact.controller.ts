import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common'
import { contactMessageInputSchema, type ContactMessagePayload } from 'adlens-shared'
import { RequestIpSource } from '../common/ip-source.decorator'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { IpSource } from '../ip-quota/client-ip'
import { ContactService } from './contact.service'

// Public: anyone can write, signed in or not.
@Controller('v1/contact')
export class ContactController {
    constructor(private readonly contact: ContactService) {}

    @Post()
    @HttpCode(HttpStatus.NO_CONTENT)
    send(
        @RequestIpSource() ipSource: IpSource,
        @Body(new ZodValidationPipe(contactMessageInputSchema)) input: ContactMessagePayload,
    ): Promise<void> {
        return this.contact.send(input, ipSource)
    }
}
