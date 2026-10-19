import type { Analysis, Job } from 'adlens-shared'
import type { StoredAnalysis, StoredJob } from '../database/job.doc'

// Analyses stored before 2026-10-19 hold the time as ISO text until the dates migration rewrites them; `new Date`
// reads both.
const toPublicAnalysis = (analysis: StoredAnalysis): Analysis => ({
    ...analysis,
    completedAt: new Date(analysis.completedAt).toISOString(),
})

export const toStoredAnalysis = (analysis: Analysis): StoredAnalysis => ({
    ...analysis,
    completedAt: new Date(analysis.completedAt),
})

// The only way a stored job leaves the API: owner, storage location, execution and accounting stay server-side.
export const toPublicJob = (job: StoredJob): Job => ({
    id: job._id.toString(),
    status: job.status,
    settings: job.settings,
    file: { name: job.file.name, contentType: job.file.contentType, size: job.file.size },
    media: job.media,
    analysis: job.analysis && toPublicAnalysis(job.analysis),
    errorCode: job.errorCode,
    sampleId: job.sampleId,
    // Jobs created before presets existed have no field.
    presetId: job.presetId ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
})
