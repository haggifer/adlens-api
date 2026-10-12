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
    // Replaces MAIL_FROM's display name for this message; the address stays MAIL_FROM's.
    fromName?: string
    attachments?: MailAttachment[]
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

const encodeAttachments = (attachments: MailAttachment[] | undefined) =>
    attachments?.map(({ filename, content }) => ({ filename, content: content.toString('base64') }))

// MAIL_FROM is either an address or "Name <address>".
const withDisplayName = (from: string, name: string | undefined): string => {
    if (!name) {
        return from
    }

    const address = /<([^>]+)>/.exec(from)?.[1] ?? from

    // Quotes and backslashes would break out of the quoted name.
    return `"${name.replace(/["\\]/g, '')}" <${address}>`
}

const toResendPayload = (from: string, { to, subject, text, html, replyTo, fromName, attachments }: MailMessage) => ({
    from: withDisplayName(from, fromName),
    to: [to],
    subject,
    text,
    html,
    reply_to: replyTo,
    attachments: encodeAttachments(attachments),
})

export abstract class Mailer {
    abstract send(message: MailMessage): Promise<void>
}

export class ResendMailer extends Mailer {
    constructor(
        private readonly apiKey: string,
        private readonly from: string,
    ) {
        super()
    }

    async send(message: MailMessage): Promise<void> {
        const response = await this.post(toResendPayload(this.from, message))

        // The status only: the callers log this message, and Resend's error body can quote the recipient's address.
        if (!response.ok) {
            throw new Error(`Resend responded ${response.status}`)
        }
    }

    private post(payload: ReturnType<typeof toResendPayload>): Promise<Response> {
        return fetch(RESEND_ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
    }
}
