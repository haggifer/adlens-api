// Gmail delivers ann@gmail.com, a.n.n@gmail.com and ann@googlemail.com to one mailbox; most providers (Gmail, Outlook,
// iCloud, Fastmail) also deliver ann+anything@ there. A mailbox gets one confirmed account, so aliases can't stack the
// weekly allowance.
const GMAIL_DOMAINS = ['gmail.com', 'googlemail.com']

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g

const escapeRegex = (value: string): string => value.replace(REGEX_SPECIALS, '\\$&')

const splitAddress = (email: string): { local: string; domain: string } => {
    const normalized = email.trim().toLowerCase()
    const at = normalized.lastIndexOf('@')

    return { local: normalized.slice(0, at), domain: normalized.slice(at + 1) }
}

// The mailbox part of a local part: without its +tag, and for Gmail without dots.
const toMailbox = (local: string, isGmail: boolean): string => {
    const untagged = local.split('+')[0]

    return isGmail ? untagged.replaceAll('.', '') : untagged
}

// Any dot between letters, for Gmail, which ignores them.
const toLocalPattern = (mailbox: string, isGmail: boolean): string =>
    isGmail ? [...mailbox].map(escapeRegex).join('\\.?') : escapeRegex(mailbox)

const toDomainPattern = (domain: string, isGmail: boolean): string =>
    isGmail ? `(?:${GMAIL_DOMAINS.map(escapeRegex).join('|')})` : escapeRegex(domain)

// Matches every stored address that delivers to the same mailbox as `email`, `email` itself included. Stored addresses
// are lowercase (Better Auth lowercases them), so the pattern is too.
export const buildMailboxPattern = (email: string): RegExp => {
    const { local, domain } = splitAddress(email)
    const isGmail = GMAIL_DOMAINS.includes(domain)
    const mailbox = toMailbox(local, isGmail)

    return new RegExp(`^${toLocalPattern(mailbox, isGmail)}(?:\\+[^@]*)?@${toDomainPattern(domain, isGmail)}$`)
}
