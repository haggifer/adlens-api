import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module'
import { MailModule } from '../mail/mail.module'
import { ContactController } from './contact.controller'
import { ContactService } from './contact.service'

@Module({
    imports: [DatabaseModule, MailModule],
    controllers: [ContactController],
    providers: [ContactService],
})
export class ContactModule {}
