import { type Analysis, JobStatus, VideoMimeType } from 'adlens-shared'
import { Types } from 'mongoose'
import type { StoredAnalysis, StoredJob } from '../database/job.doc'
import { toPublicJob, toStoredAnalysis } from './job.mapper'

const COMPLETED_AT = '2026-10-19T10:00:00.000Z'
const ANALYSIS: Analysis = {
    model: 'fake-model',
    promptVersion: 'test',
    rulesetVersion: '1.0.0',
    transcript: '',
    findings: [],
    metadataChecks: [],
    advisories: [],
    completedAt: COMPLETED_AT,
}

const buildJob = (analysis: StoredAnalysis): StoredJob => ({
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId().toString(),
    status: JobStatus.Analyzed,
    settings: { platforms: [], placements: [], markets: [] },
    file: { name: 'ad.mp4', contentType: VideoMimeType.Mp4, size: 1, bucket: 'bucket', path: 'uploads/ad.mp4' },
    analysis,
    attempts: 1,
    chargedRunId: null,
    chargedIpRunId: null,
    hasPassedChallenge: false,
    appliedPresetId: null,
    presetId: null,
    createdAt: new Date(COMPLETED_AT),
    updatedAt: new Date(COMPLETED_AT),
})

describe('the job mapper', () => {
    it('stores the completion time as a date and sends it back as ISO text', () => {
        const stored = toStoredAnalysis(ANALYSIS)

        expect(stored.completedAt).toEqual(new Date(COMPLETED_AT))
        expect(toPublicJob(buildJob(stored)).analysis).toEqual(ANALYSIS)
    })

    it('sends an analysis stored before the dates migration unchanged', () => {
        const legacy = { ...ANALYSIS } as unknown as StoredAnalysis

        expect(toPublicJob(buildJob(legacy)).analysis).toEqual(ANALYSIS)
    })
})
