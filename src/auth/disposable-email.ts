import { disposableEmailBlocklistSet } from 'disposable-email-domains-js'

// Built once: the package builds a new Set on every call.
const DISPOSABLE_DOMAINS = disposableEmailBlocklistSet()

// Also matches subdomains (inbox.mailinator.com), which many throwaway services hand out. A bare TLD is never checked.
export const isDisposableEmail = (email: string): boolean => {
    const labels = email
        .slice(email.lastIndexOf('@') + 1)
        .trim()
        .toLowerCase()
        .split('.')

    return labels.slice(0, -1).some((_, index) => DISPOSABLE_DOMAINS.has(labels.slice(index).join('.')))
}
