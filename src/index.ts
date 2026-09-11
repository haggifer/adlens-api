import { setGlobalOptions } from 'firebase-functions/v2'
import { onRequest } from 'firebase-functions/v2/https'

import { createApp } from '@/app'

setGlobalOptions({ region: 'us-central1', maxInstances: 10 })

// 1GiB/120s covers the synchronous content verification (download + ffprobe) in /analyze.
export const api = onRequest({ memory: '1GiB', timeoutSeconds: 120 }, createApp())

export { analyzeVideo } from '@/tasks/analyze-video'
