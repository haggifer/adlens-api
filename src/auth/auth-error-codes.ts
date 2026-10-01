// Better Auth error codes exchanged only with the web, which maps each one to its own copy. They travel in Better
// Auth's error body (`code`), not in the adlens-shared error shape, so they aren't part of that contract.

// An auth email couldn't be sent, so the request failed rather than promise one.
export const EMAIL_NOT_SENT = 'EMAIL_NOT_SENT'

// An anonymous history couldn't be moved to the account, or a provider can't be linked to this session.
export const ACCOUNT_LINK_FAILED = 'ACCOUNT_LINK_FAILED'

// A confirmation link was opened without a session of an account: the web asks the visitor to sign in and opens it
// again.
export const SIGN_IN_REQUIRED = 'SIGN_IN_REQUIRED'

// A confirmation link was opened while signed in to another account.
export const EMAIL_MISMATCH = 'EMAIL_MISMATCH'
