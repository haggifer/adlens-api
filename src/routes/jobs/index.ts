import { Router } from 'express'

import { uidOf } from '@/lib/auth'
import { requireBody } from '@/utils/validation'
import { createJob, deleteJob, getJob, listJobs, updateJob } from '@/services/jobs'
import type { CreateJobInput, JobFile } from 'adlens-types'

export const jobsRouter = Router()

jobsRouter.post('/', async (req, res) => {
    const body = requireBody(req.body)
    const job = await createJob(uidOf(req), { file: body.file } as CreateJobInput)
    res.status(201).json(job)
})

jobsRouter.get('/', async (req, res) => {
    res.json(await listJobs(uidOf(req)))
})

jobsRouter.get('/:id', async (req, res) => {
    res.json(await getJob(uidOf(req), req.params.id))
})

jobsRouter.patch('/:id', async (req, res) => {
    const body = requireBody(req.body)
    res.json(await updateJob(uidOf(req), req.params.id, { file: body.file as JobFile }))
})

jobsRouter.delete('/:id', async (req, res) => {
    await deleteJob(uidOf(req), req.params.id)
    res.status(204).end()
})
