import { JobErrorCode, JobStatus } from 'adlens-shared'
import { UserAccess } from '../common/user-access'
import { contactEmail, type ContactEmailInput } from './contact-email'
import type { ContactAccount } from './contact-sender'

const MEMBER: ContactAccount = {
    id: '6ac913b27c1ba632f077e063',
    access: UserAccess.Member,
    email: 'ann@example.com',
    createdAt: new Date('2026-10-02T08:00:00Z'),
    quota: { used: 3, limit: 5, nextFreeAt: '2026-10-16T09:30:00.000Z' },
    lastJob: {
        id: '6ac9142b7c1ba632f077e078',
        status: JobStatus.Error,
        errorCode: JobErrorCode.UploadFailed,
        createdAt: new Date('2026-10-09T16:47:00Z'),
    },
}

const buildInput = (overrides: Partial<ContactEmailInput> = {}): ContactEmailInput => ({
    to: 'team@adlens.test',
    message: { email: 'ann@example.com', message: 'The upload didn’t finish on my phone.\nI tried twice.' },
    sender: { account: MEMBER, device: 'Chrome 154 · Android 10', lookupError: null },
    ref: '3F9A2C',
    apiVersion: 'adlens-api-00029-jkl',
    ...overrides,
})

describe('contactEmail', () => {
    it('puts the first line of the message and the reference in the subject, and replies to the sender', () => {
        const mail = contactEmail(buildInput())

        expect(mail.subject).toBe('[AdLens] The upload didn’t finish on my phone. · ref 3F9A2C')
        expect(mail.replyTo).toBe('ann@example.com')
        expect(mail.fromName).toBe('ann@example.com')
    })

    it('cuts a long first line in the subject', () => {
        const mail = contactEmail(buildInput({ message: { email: 'ann@example.com', message: 'word '.repeat(40) } }))

        expect(mail.subject).toMatch(/^\[AdLens\] .{59}… · ref 3F9A2C$/)
    })

    it('shows the message first, then the facts a support reader needs', () => {
        expect(contactEmail(buildInput()).text).toBe(
            [
                'The upload didn’t finish on my phone.\nI tried twice.',
                '',
                '—',
                'From: ann@example.com',
                'Account: member · 6ac913b27c1ba632f077e063 · since 2026-10-02',
                'Analyses: 3 of 5 in the last 7 days · next free 2026-10-16 09:30 UTC',
                'Last analysis: 6ac9142b7c1ba632f077e078 · error (UPLOAD_FAILED) · 2026-10-09 16:47 UTC',
                'Device: Chrome 154 · Android 10',
                'Ref: 3F9A2C · API adlens-api-00029-jkl',
            ].join('\n'),
        )
    })

    it('names the account’s own address when the sender wrote from another one', () => {
        const mail = contactEmail(buildInput({ message: { email: 'other@example.com', message: 'Hello there' } }))

        expect(mail.text).toContain('Account email: ann@example.com')
    })

    it('says when the sender wasn’t signed in, and lists no account facts', () => {
        const text = contactEmail(buildInput({ sender: { account: null, device: null, lookupError: null } })).text

        expect(text).toContain('Account: not signed in')
        expect(text).not.toContain('Analyses:')
        expect(text).not.toContain('Device:')
    })

    it('says the account couldn’t be read, and still sends', () => {
        const sender = { account: null, device: null, lookupError: 'connection refused' }

        expect(contactEmail(buildInput({ sender })).text).toContain("Account: couldn't be read (connection refused)")
    })

    it('shows an admin’s analyses as unlimited and a sender without analyses as such', () => {
        const admin = {
            ...MEMBER,
            access: UserAccess.Admin,
            quota: { used: 40, limit: null, nextFreeAt: null },
            lastJob: null,
        }
        const text = contactEmail(buildInput({ sender: { account: admin, device: null, lookupError: null } })).text

        expect(text).toContain('Analyses: 40 in the last 7 days, unlimited (admin)')
        expect(text).toContain('Last analysis: none')
    })

    it('lists the screenshots and leaves the API version out outside Cloud Run', () => {
        const attachments = [{ filename: 'shot.png', content: Buffer.from('png') }]
        const mail = contactEmail(buildInput({ attachments, apiVersion: null }))

        expect(mail.text).toContain('Screenshots: shot.png')
        expect(mail.text).toContain('Ref: 3F9A2C\n'.trim())
        expect(mail.text).not.toContain('API ')
        expect(mail.attachments).toBe(attachments)
    })

    it('escapes the message and the facts in the HTML version', () => {
        const message = { email: 'ann@example.com', message: '<script>alert(1)</script> hello' }
        const html = contactEmail(buildInput({ message })).html

        expect(html).not.toContain('<script>')
        expect(html).toContain('&lt;script&gt;')
    })
})
