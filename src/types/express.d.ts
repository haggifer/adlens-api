import 'express'

// Carries the authenticated uid set by requireAuth.
declare module 'express-serve-static-core' {
    interface Request {
        uid?: string
    }
}
