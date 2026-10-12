import type { ContactMessagePayload, Quota } from 'adlens-shared'
import type { MailAttachment, MailMessage } from '../mail/mailer'
import type { ContactAccount, ContactJob, ContactSender } from './contact-sender'

export interface ContactEmailInput {
    to: string
    message: ContactMessagePayload
    sender: ContactSender
    // A short reference, also logged, that ties the email to the API's logs.
    ref: string
    // The API revision that handled the message; null outside Cloud Run.
    apiVersion: string | null
    attachments?: MailAttachment[]
}

type Fact = [label: string, value: string]

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

// Enough of the message's first line to triage from the inbox list.
const SUBJECT_PREVIEW_LENGTH = 60

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char])

// "2026-10-16 09:30 UTC": one zone for every reader of a shared inbox, and it sorts.
const formatUtc = (date: Date): string => `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`

const toPreview = (message: string): string => {
    const firstLine = message.trim().split('\n')[0].replace(/\s+/g, ' ')

    return firstLine.length > SUBJECT_PREVIEW_LENGTH
        ? `${firstLine.slice(0, SUBJECT_PREVIEW_LENGTH - 1).trimEnd()}…`
        : firstLine
}

const describeAccount = ({ access, id, createdAt }: ContactAccount): string =>
    [access, id, createdAt && `since ${formatUtc(createdAt).slice(0, 10)}`].filter(Boolean).join(' · ')

const describeQuota = ({ used, limit, nextFreeAt }: Quota): string => {
    if (limit === null) {
        return `${used} in the last 7 days, unlimited (admin)`
    }

    const nextFree = nextFreeAt ? ` · next free ${formatUtc(new Date(nextFreeAt))}` : ''

    return `${used} of ${limit} in the last 7 days${nextFree}`
}

const describeJob = ({ id, status, errorCode, createdAt }: ContactJob): string =>
    `${id} · ${status}${errorCode ? ` (${errorCode})` : ''} · ${formatUtc(createdAt)}`

const describeSignIn = ({ account, lookupError }: ContactSender): string => {
    if (account) {
        return describeAccount(account)
    }

    return lookupError ? `couldn't be read (${lookupError})` : 'not signed in'
}

// The account's facts, when the sender was signed in. Its own address shows only when it isn't the one to reply to.
const toAccountFacts = (account: ContactAccount | null, replyTo: string): Fact[] => {
    if (!account) {
        return []
    }

    const ownEmail: Fact[] = account.email && account.email !== replyTo ? [['Account email', account.email]] : []

    return [
        ...ownEmail,
        ['Analyses', describeQuota(account.quota)],
        ['Last analysis', account.lastJob ? describeJob(account.lastJob) : 'none'],
    ]
}

// In the order a support reader needs them: who, what they can do, what happened last, where it ran.
const toFacts = ({ message, sender, ref, apiVersion, attachments = [] }: ContactEmailInput): Fact[] => {
    const facts: Fact[] = [
        ['From', message.email],
        ['Account', describeSignIn(sender)],
        ...toAccountFacts(sender.account, message.email),
    ]

    if (sender.device) {
        facts.push(['Device', sender.device])
    }

    if (attachments.length) {
        facts.push(['Screenshots', attachments.map(({ filename }) => filename).join(', ')])
    }

    facts.push(['Ref', apiVersion ? `${ref} · API ${apiVersion}` : ref])

    return facts
}

// "ann via AdLens" in the inbox list, so it reads like mail from the person; never their full address, which spam
// filters take for a spoofed sender.
const toSenderName = (email: string): string => `${email.split('@')[0]} via AdLens`

const toText = (message: string, facts: Fact[]): string =>
    `${message}\n\n—\n${facts.map(([label, value]) => `${label}: ${value}`).join('\n')}`

const toHtmlRow = ([label, value]: Fact): string =>
    `<tr><td style="padding:2px 16px 2px 0;color:#6e6e73;white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td>` +
    `<td style="padding:2px 0">${escapeHtml(value)}</td></tr>`

const toHtml = (message: string, facts: Fact[]): string => `<!doctype html>
<html>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1d1d1f">
  <div style="white-space:pre-wrap;line-height:1.5;font-size:15px">${escapeHtml(message)}</div>
  <table style="margin-top:24px;border-top:1px solid #d2d2d7;border-collapse:collapse;font-size:13px;line-height:1.4">${facts.map(toHtmlRow).join('')}</table>
</body>
</html>`

// Sent to the team, built for an inbox with many of them: the subject triages, the message comes first, the facts
// below answer the usual first questions, and a plain reply goes to the sender.
export const contactEmail = (input: ContactEmailInput): MailMessage => {
    const { to, message, ref, attachments = [] } = input
    const facts = toFacts(input)

    return {
        to,
        fromName: toSenderName(message.email),
        replyTo: message.email,
        // "ref", not "#": a # and six hex digits read as a CSS colour.
        subject: `[AdLens] ${toPreview(message.message)} · ref ${ref}`,
        text: toText(message.message, facts),
        html: toHtml(message.message, facts),
        ...(attachments.length ? { attachments } : {}),
    }
}
