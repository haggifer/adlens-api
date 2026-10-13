import type { Job } from 'adlens-shared'
import type { StoredJob } from '../database/job.doc'

// The only way a stored job leaves the API: owner, storage location, execution and accounting stay server-side.
export const toPublicJob = (job: StoredJob): Job => ({
    id: job._id.toString(),
    status: job.status,
    settings: job.settings,
    file: { name: job.file.name, contentType: job.file.contentType, size: job.file.size },
    media: job.media,
    analysis: job.analysis,
    errorCode: job.errorCode,
    sampleId: job.sampleId,
    // Jobs created before presets existed have no field.
    presetName: job.presetName ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
})
