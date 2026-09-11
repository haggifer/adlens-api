import { createJobInputSchema, type JobMedia } from 'adlens-types'
import { Router } from 'express'

import { uidOf } from '@/infra/auth'
import { AppError } from '@/infra/errors'
import { functions, storage } from '@/infra/firebase'
import { createJob, getJob, updateJob } from '@/services/jobs'
import { consumeQuota } from '@/services/quota'
import { verifyVideo } from '@/services/verify'
import type { AnalyzePayload } from '@/tasks/analyze-video'

export const jobsRouter = Router()

// POST /v1/jobs — create a pending job and reserve the upload path. Quota is NOT
// spent here; a failed upload shouldn't cost a run.
jobsRouter.post('/', async (req, res) => {
    const uid = uidOf(req)
    const input = createJobInputSchema.parse(req.body)
    const job = await createJob(uid, input)
    res.status(201).json({ job })
})

// POST /v1/jobs/:jobId/analyze — verify the uploaded bytes, consume quota, enqueue
// the transcription. Returns 202; the client watches the job doc for transitions.
jobsRouter.post('/:jobId/analyze', async (req, res) => {
    const uid = uidOf(req)
    const { jobId } = req.params
    const job = await getJob(uid, jobId)

    if (job.status !== 'pending') {
        throw new AppError(409, 'Job is not pending', 'invalid_state')
    }

    if (!job.file) {
        throw new AppError(409, 'Job has no uploaded video', 'no_file')
    }

    let media: JobMedia

    try {
        media = await verifyVideo(job.file)
    } catch (err) {
        await storage
            .bucket(job.file.bucket)
            .file(job.file.path)
            .delete()
            .catch(() => {})
        await updateJob(uid, jobId, {
            status: 'error',
            error: err instanceof AppError ? err.message : 'Verification failed',
        })

        throw err instanceof AppError ? err : new AppError(422, 'Verification failed', 'invalid_video')
    }

    await consumeQuota(uid)

    const queued = await updateJob(uid, jobId, { status: 'queued', media })
    await functions.taskQueue('analyzeVideo').enqueue({ uid, jobId } satisfies AnalyzePayload)

    res.status(202).json({ job: queued })
})
