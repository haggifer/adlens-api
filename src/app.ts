import cors from 'cors'
import express from 'express'
import helmet from 'helmet'

import { requireAuth } from '@/infra/auth'
import { errorHandler, notFound } from '@/infra/errors'
import { healthRouter } from '@/routes/health'
import { v1Router } from '@/routes/v1/index'

// Browser origins allowed to call the API. Set ALLOWED_ORIGINS (comma-separated) to add the
// deployed frontend origin(s); localhost is always allowed for local development.
const ALLOWED_ORIGINS = [
    'http://localhost:3000',
    ...(process.env.ALLOWED_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ?? []),
]

export const createApp = () => {
    const app = express()

    app.disable('x-powered-by')
    app.use(helmet())
    app.use(cors({ origin: ALLOWED_ORIGINS }))
    app.use(express.json({ limit: '1mb' }))

    app.use('/health', healthRouter)
    app.use('/v1', requireAuth, v1Router)

    app.use(notFound)
    app.use(errorHandler)

    return app
}
