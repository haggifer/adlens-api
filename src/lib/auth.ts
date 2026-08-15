import type { RequestHandler } from 'express'

import { verifyIdToken } from '@/lib/firebase'
import { AppError } from '@/lib/errors'

// uid is taken from the verified token only, never from the request body.
export const requireAuth: RequestHandler = async (req, _res, next) => {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null

    if (!token) {
        throw new AppError(401, 'Missing bearer token', 'unauthenticated')
    }

    try {
        const decoded = await verifyIdToken(token)
        req.uid = decoded.uid
        next()
    } catch {
        throw new AppError(401, 'Invalid or expired token', 'unauthenticated')
    }
}

export const uidOf = (req: { uid?: string }): string => {
    if (!req.uid) {
        throw new AppError(401, 'Unauthenticated', 'unauthenticated')
    }

    return req.uid
}
