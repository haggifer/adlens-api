import type { ErrorRequestHandler, RequestHandler } from 'express'

export class AppError extends Error {
    constructor(
        public status: number,
        message: string,
        public code = 'error',
    ) {
        super(message)
        this.name = 'AppError'
    }
}

export const notFound: RequestHandler = (_req, _res, next) => {
    next(new AppError(404, 'Route not found', 'not_found'))
}

// Express 5 forwards rejected promises from async handlers here automatically.
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    const isApp = err instanceof AppError
    const status = isApp ? err.status : 500
    const code = isApp ? err.code : 'internal'
    const message = isApp ? err.message : 'Internal server error'

    if (!isApp) {
        console.error('Unhandled error:', err)
    }

    res.status(status).json({ error: { message, code } })
}
