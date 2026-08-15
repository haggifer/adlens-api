import { onTaskDispatched } from 'firebase-functions/v2/tasks'

import { gcsUri } from '@/utils/paths'
import { getJob, updateJob } from '@/services/jobs'
import { transcribeVideo as runTranscription } from '@/services/analyze-video'

// Identifiers only — the worker re-fetches state from Firestore.
export interface TranscribePayload {
    uid: string
    jobId: string
}

// Export name doubles as the queue name used by enqueueTranscribe.
export const transcribeVideo = onTaskDispatched<TranscribePayload>(
    {
        memory: '1GiB',
        timeoutSeconds: 540,
        retryConfig: { maxAttempts: 3, minBackoffSeconds: 5 },
        rateLimits: { maxConcurrentDispatches: 6 },
    },
    async (req) => {
        const { uid, jobId } = req.data
        const job = await getJob(uid, jobId)

        if (!job.file) {
            await updateJob(uid, jobId, { status: 'error', error: 'No file attached to job' })
            return
        }

        try {
            await updateJob(uid, jobId, { status: 'transcribing' })

            const uri = gcsUri(job.file.bucket, job.file.path)
            const transcript = await runTranscription({ gcsUri: uri, mimeType: job.file.contentType })

            await updateJob(uid, jobId, { status: 'transcribed', transcript })
        } catch (err) {
            // Rethrow after recording so Cloud Tasks retries.
            await updateJob(uid, jobId, {
                status: 'error',
                error: err instanceof Error ? err.message : 'Transcription failed',
            })
            throw err
        }
    },
)
