import type { MailMessage } from './mailer'

const layout = (heading: string, body: string, actionLabel: string, url: string): string => `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:#f5f5f7;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1d1d1f">
  <table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
    <tr><td>
      <p style="margin:0 0 24px;font-weight:700;font-size:18px">AdLens</p>
      <h1 style="margin:0 0 12px;font-size:20px">${heading}</h1>
      <p style="margin:0 0 24px;line-height:1.5">${body}</p>
      <a href="${url}" style="display:inline-block;background:#0d9488;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${actionLabel}</a>
      <p style="margin:24px 0 0;font-size:13px;color:#6e6e73;line-height:1.5">If the button doesn't work, open this link:<br>${url}</p>
    </td></tr>
  </table>
</body>
</html>`

export const verificationEmail = (to: string, url: string): MailMessage => ({
    to,
    subject: 'Confirm your AdLens email',
    text: `Confirm your email to start using AdLens. The link expires in 24 hours.\n\n${url}\n\nIf you didn't sign up, you can ignore this email.`,
    html: layout(
        'Confirm your email',
        "Confirm your address to start using AdLens. The link expires in 24 hours. If you didn't sign up, you can ignore this email.",
        'Confirm email',
        url,
    ),
})

export const passwordResetEmail = (to: string, url: string): MailMessage => ({
    to,
    subject: 'Reset your AdLens password',
    text: `Use this link to choose a new password. It expires in one hour.\n\n${url}\n\nIf you didn't ask for this, you can ignore this email.`,
    html: layout(
        'Reset your password',
        "Choose a new password with the link below. It expires in one hour. If you didn't ask for this, you can ignore this email.",
        'Choose a new password',
        url,
    ),
})
