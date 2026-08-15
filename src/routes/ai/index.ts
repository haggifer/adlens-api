import { Router } from 'express'

import { analyzeVideo } from '@/routes/ai/analyze-video'

export const aiRouter = Router()

aiRouter.post('/analyze-video', analyzeVideo)
