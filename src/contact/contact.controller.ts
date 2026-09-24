import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common'
import { contactMessageInputSchema, type ContactMessagePayload } from 'adlens-shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { ContactService } from './contact.service'

// Public: anyone can write, signed in or not.
@Controller('v1/contact')
export class ContactController {
    constructor(private readonly contact: ContactService) {}

    @Post()
    @HttpCode(HttpStatus.NO_CONTENT)
    send(@Body(new ZodValidationPipe(contactMessageInputSchema)) input: ContactMessagePayload): Promise<void> {
        return this.contact.send(input)
    }
}
