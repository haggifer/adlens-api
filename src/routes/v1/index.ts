import { Router } from 'express'

import { jobsRouter } from '@/routes/v1/jobs'
import { meRouter } from '@/routes/v1/me'

export const v1Router = Router()

v1Router.use('/jobs', jobsRouter)
v1Router.use('/me', meRouter)
