import cors from 'cors'
import express from 'express'
import helmet from 'helmet'

import { requireAuth } from '@/lib/auth'
import { errorHandler, notFound } from '@/lib/errors'
import { healthRouter } from '@/routes/health'
import { jobsRouter } from '@/routes/jobs/index'
import { aiRouter } from '@/routes/ai/index'

// Browser origins allowed to call the API. Add the deployed frontend origin here.
const ALLOWED_ORIGINS = ['http://localhost:3000']

export const createApp = () => {
    const app = express()

    app.disable('x-powered-by')
    app.use(helmet())
    app.use(cors({ origin: ALLOWED_ORIGINS }))
    app.use(express.json({ limit: '1mb' }))

    app.use('/health', healthRouter)
    app.use('/jobs', requireAuth, jobsRouter)
    app.use('/ai', requireAuth, aiRouter)

    app.use(notFound)
    app.use(errorHandler)

    return app
}
