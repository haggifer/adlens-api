export interface MailAttachment {
    filename: string
    content: Buffer
}

export interface MailMessage {
    to: string
    subject: string
    text: string
    html: string
    replyTo?: string
    attachments?: MailAttachment[]
}

export abstract class Mailer {
    abstract send(message: MailMessage): Promise<void>
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

export class ResendMailer extends Mailer {
    constructor(
        private readonly apiKey: string,
        private readonly from: string,
    ) {
        super()
    }

    async send({ to, subject, text, html, replyTo, attachments }: MailMessage): Promise<void> {
        const encodedAttachments = attachments?.map(({ filename, content }) => ({
            filename,
            content: content.toString('base64'),
        }))
        const response = await fetch(RESEND_ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: this.from,
                to: [to],
                subject,
                text,
                html,
                reply_to: replyTo,
                attachments: encodedAttachments,
            }),
        })

        if (!response.ok) {
            throw new Error(`Resend responded ${response.status}: ${await response.text()}`)
        }
    }
}
