import type { RequestHandler } from 'express'

import { uidOf } from '@/lib/auth'
import { AppError } from '@/lib/errors'
import { functions } from '@/lib/firebase'
import { requireBody, requireString } from '@/utils/validation'
import { getJob, updateJob } from '@/services/jobs'
import type { TranscribePayload } from '@/tasks/transcribe-video'

// Enqueues the heavy Gemini work and returns 202 immediately. The worker trusts
// the uid because only the server can enqueue.
export const analyzeVideo: RequestHandler = async (req, res) => {
    const uid = uidOf(req)
    const body = requireBody(req.body)
    const jobId = requireString(body.jobId, 'jobId')

    const job = await getJob(uid, jobId)

    if (!job.file) {
        throw new AppError(409, 'Job has no uploaded video yet', 'failed_precondition')
    }

    await updateJob(uid, jobId, { status: 'queued' })
    // Queue name must match the exported task function.
    await functions.taskQueue('transcribeVideo').enqueue({ uid, jobId } satisfies TranscribePayload)

    res.status(202).json({ jobId, status: 'queued' })
}
