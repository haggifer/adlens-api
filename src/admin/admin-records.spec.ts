import { JobStatus } from 'adlens-shared'
import { Types } from 'mongoose'
import {
    getSampleObjectIds,
    JOB_PROJECTION,
    type JobRecord,
    toAdminJob,
    toAdminUser,
    type UserRecord,
} from './admin-records'

const JOB_ID = new Types.ObjectId('66f000000000000000000001')
const SAMPLE_ID = '66f0000000000000000000aa'
const CREATED_AT = new Date('2026-09-30T10:00:00.000Z')

const CALL = {
    at: new Date('2026-09-30T10:01:00.000Z'),
    model: 'gemini-3.6-flash',
    location: 'global',
    promptTokens: 8447,
    candidatesTokens: 127,
    thoughtsTokens: 965,
    cachedTokens: 4000,
    promptTokensByModality: { AUDIO: 750, VIDEO: 1980, TEXT: 5717 },
    cachedTokensByModality: { TEXT: 4000 },
    durationMs: 22040,
    trafficType: 'ON_DEMAND_FLEX',
}

const job = (fields: Partial<JobRecord> = {}): JobRecord => ({
    _id: JOB_ID,
    createdAt: CREATED_AT,
    status: JobStatus.Analyzed,
    userId: 'u1',
    file: { name: 'ad.mp4' },
    ...fields,
})

const user = (fields: Partial<UserRecord> = {}): UserRecord => ({
    _id: new Types.ObjectId('66f000000000000000000002'),
    createdAt: CREATED_AT,
    email: 'ana@example.com',
    ...fields,
})

describe('toAdminJob', () => {
    it('keeps the job’s status, owner, file name and every recorded call, dates as ISO strings', () => {
        expect(toAdminJob(job({ usage: { calls: [CALL] } }), new Map())).toEqual({
            id: '66f000000000000000000001',
            createdAt: '2026-09-30T10:00:00.000Z',
            status: JobStatus.Analyzed,
            userId: 'u1',
            file: { name: 'ad.mp4' },
            usage: { calls: [{ ...CALL, at: '2026-09-30T10:01:00.000Z' }] },
        })
    })

    it('returns only the listed fields of a call, whatever else the record holds', () => {
        const callWithExtras = { ...CALL, totalTokens: 9539, finishReason: 'STOP' }

        const [adminCall] = toAdminJob(job({ usage: { calls: [callWithExtras] } }), new Map()).usage?.calls ?? []

        expect(Object.keys(adminCall).sort()).toEqual(Object.keys(CALL).sort())
    })

    it('tells a job recorded before calls were (usage, no calls) from one that never reached Gemini (no usage)', () => {
        expect(toAdminJob(job({ usage: {} }), new Map()).usage).toEqual({})
        expect(toAdminJob(job(), new Map())).not.toHaveProperty('usage')
    })

    it('names a sample job after its sample, and leaves the title out when the sample is gone', () => {
        const titles = new Map([[SAMPLE_ID, 'Energy drink']])

        expect(toAdminJob(job({ sampleId: SAMPLE_ID }), titles).sampleTitle).toBe('Energy drink')
        expect(toAdminJob(job({ sampleId: '66f0000000000000000000bb' }), titles).sampleTitle).toBeUndefined()
        expect(toAdminJob(job({ sampleId: SAMPLE_ID }), titles).sampleId).toBe(SAMPLE_ID)
    })

    it('falls back to the id’s timestamp when the job has no createdAt', () => {
        expect(toAdminJob(job({ createdAt: undefined }), new Map()).createdAt).toBe(JOB_ID.getTimestamp().toISOString())
    })
})

describe('JOB_PROJECTION', () => {
    it('reads every field of a recorded call', () => {
        for (const key of Object.keys(CALL)) {
            expect([key, JOB_PROJECTION[`usage.calls.${key}` as keyof typeof JOB_PROJECTION]]).toEqual([key, 1])
        }
    })
})

describe('getSampleObjectIds', () => {
    it('collects each valid sample id once, skipping ids that are not ObjectIds', () => {
        const ids = getSampleObjectIds([
            job({ sampleId: SAMPLE_ID }),
            job({ sampleId: SAMPLE_ID }),
            job({ sampleId: 'demo' }),
            job({ sampleId: 'not-an-id' }),
            job(),
        ])

        expect(ids.map((id) => id.toString())).toEqual([SAMPLE_ID])
    })
})

describe('toAdminUser', () => {
    it('returns the id, creation date, email and access flags', () => {
        expect(toAdminUser(user({ emailVerified: true, isAdmin: true }))).toEqual({
            id: '66f000000000000000000002',
            createdAt: '2026-09-30T10:00:00.000Z',
            email: 'ana@example.com',
            isAnonymous: false,
            emailVerified: true,
            isAdmin: true,
        })
    })

    it('treats missing flags as false', () => {
        const { isAnonymous, emailVerified, isAdmin } = toAdminUser(user())

        expect({ isAnonymous, emailVerified, isAdmin }).toEqual({
            isAnonymous: false,
            emailVerified: false,
            isAdmin: false,
        })
    })

    it('hides an anonymous user’s placeholder email', () => {
        const anonymous = user({ isAnonymous: true, email: '66f000000000000000000002@anonymous.placeholder.invalid' })

        expect(toAdminUser(anonymous).email).toBeNull()
    })

    it('falls back to the id’s timestamp when the user has no createdAt', () => {
        const record = user({ createdAt: undefined })

        expect(toAdminUser(record).createdAt).toBe(record._id.getTimestamp().toISOString())
    })
})
