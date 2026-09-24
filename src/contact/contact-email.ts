import type { ContactMessagePayload } from 'adlens-shared'
import type { MailMessage } from '../mail/mailer'

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char])

// Sent to the team; Reply-To is the visitor, so answering is a plain reply.
export const contactEmail = (to: string, { email, message }: ContactMessagePayload): MailMessage => ({
    to,
    replyTo: email,
    subject: `AdLens contact from ${email}`,
    text: `${message}\n\n-- Sent from the AdLens contact form by ${email}`,
    html: `<!doctype html>
<html>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1d1d1f">
  <p style="margin:0 0 16px;font-size:13px;color:#6e6e73">From the AdLens contact form, reply to ${escapeHtml(email)}</p>
  <div style="white-space:pre-wrap;line-height:1.5">${escapeHtml(message)}</div>
</body>
</html>`,
})
