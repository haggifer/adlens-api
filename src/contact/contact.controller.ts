import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common'
import {
    type CreateContactUploadsInput,
    createContactUploadsInputSchema,
    type CreateContactUploadsResponse,
    sendContactMessageInputSchema,
    type SendContactMessagePayload,
} from 'adlens-shared'
import type { Request } from 'express'
import { RequestIpSource } from '../common/ip-source.decorator'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { IpSource } from '../ip-quota/client-ip'
import { ContactService } from './contact.service'

// Public: anyone can write, signed in or not; a session, when there is one, only adds facts to the email.
@Controller('v1/contact')
export class ContactController {
    constructor(private readonly contact: ContactService) {}

    @Post('uploads')
    createUploads(
        @RequestIpSource() ipSource: IpSource,
        @Body(new ZodValidationPipe(createContactUploadsInputSchema)) input: CreateContactUploadsInput,
    ): Promise<CreateContactUploadsResponse> {
        return this.contact.createUploads(input, ipSource)
    }

    @Post()
    @HttpCode(HttpStatus.NO_CONTENT)
    send(
        @Req() req: Request,
        @RequestIpSource() ipSource: IpSource,
        @Body(new ZodValidationPipe(sendContactMessageInputSchema)) input: SendContactMessagePayload,
    ): Promise<void> {
        return this.contact.send(input, ipSource, req.headers)
    }
}
