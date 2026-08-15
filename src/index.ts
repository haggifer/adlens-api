import { setGlobalOptions } from 'firebase-functions/v2'
import { onRequest } from 'firebase-functions/v2/https'

import { createApp } from '@/app'

setGlobalOptions({ region: 'us-central1', maxInstances: 10 })

export const api = onRequest({ memory: '256MiB', timeoutSeconds: 60 }, createApp())

export { transcribeVideo } from '@/tasks/transcribe-video'
