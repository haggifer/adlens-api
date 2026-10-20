import type { AdminJob, AdminModelCall, AdminUser } from 'adlens-shared'
import { Types } from 'mongoose'
import type { ModelCall, StoredJob } from '../database/job.doc'
import type { UserExtras } from '../database/user.doc'

type CallRecord = Pick<
    ModelCall,
    | 'at'
    | 'model'
    | 'location'
    | 'promptTokens'
    | 'candidatesTokens'
    | 'thoughtsTokens'
    | 'cachedTokens'
    | 'promptTokensByModality'
    | 'cachedTokensByModality'
    | 'durationMs'
    | 'trafficType'
>

export interface JobRecord extends Pick<StoredJob, '_id' | 'status' | 'userId' | 'sampleId'> {
    createdAt?: Date
    file: { name: string }
    usage?: { calls?: CallRecord[] }
}

export interface UserRecord extends Pick<
    UserExtras,
    '_id' | 'createdAt' | 'isAnonymous' | 'emailVerified' | 'isAdmin'
> {
    // Better Auth's field; an anonymous user's is a placeholder.
    email: string
}

// `usage.promptTokens` is fetched only so a job recorded before its calls were still has `usage` and can be told from
// one that never reached Gemini.
export const JOB_PROJECTION = {
    createdAt: 1,
    status: 1,
    userId: 1,
    'file.name': 1,
    sampleId: 1,
    'usage.promptTokens': 1,
    'usage.calls.at': 1,
    'usage.calls.model': 1,
    'usage.calls.location': 1,
    'usage.calls.promptTokens': 1,
    'usage.calls.candidatesTokens': 1,
    'usage.calls.thoughtsTokens': 1,
    'usage.calls.cachedTokens': 1,
    'usage.calls.promptTokensByModality': 1,
    'usage.calls.cachedTokensByModality': 1,
    'usage.calls.durationMs': 1,
    'usage.calls.trafficType': 1,
}

export const SAMPLE_TITLE_PROJECTION = { title: 1 }

export const USER_PROJECTION = { createdAt: 1, email: 1, isAnonymous: 1, emailVerified: 1, isAdmin: 1 }

const getCreatedAt = (record: { _id: Types.ObjectId; createdAt?: Date }) =>
    (record.createdAt ?? record._id.getTimestamp()).toISOString()

const toSampleIds = (job: JobRecord): string[] =>
    job.sampleId && Types.ObjectId.isValid(job.sampleId) ? [job.sampleId] : []

export const getSampleObjectIds = (jobs: JobRecord[]): Types.ObjectId[] => {
    const ids = new Set(jobs.flatMap(toSampleIds))

    return [...ids].map((id) => new Types.ObjectId(id))
}

// Field by field, so a field added to the stored call reaches no client until it is listed here too.
const toAdminCall = (call: CallRecord): AdminModelCall => ({
    at: call.at.toISOString(),
    model: call.model,
    location: call.location,
    promptTokens: call.promptTokens,
    candidatesTokens: call.candidatesTokens,
    thoughtsTokens: call.thoughtsTokens,
    cachedTokens: call.cachedTokens,
    promptTokensByModality: call.promptTokensByModality,
    cachedTokensByModality: call.cachedTokensByModality,
    durationMs: call.durationMs,
    trafficType: call.trafficType,
})

const toAdminUsage = ({ calls }: NonNullable<JobRecord['usage']>): NonNullable<AdminJob['usage']> =>
    calls ? { calls: calls.map(toAdminCall) } : {}

export const toAdminJob = (record: JobRecord, sampleTitles: Map<string, string>): AdminJob => ({
    id: record._id.toString(),
    createdAt: getCreatedAt(record),
    status: record.status,
    userId: record.userId,
    file: { name: record.file.name },
    ...(record.sampleId && { sampleId: record.sampleId, sampleTitle: sampleTitles.get(record.sampleId) }),
    ...(record.usage && { usage: toAdminUsage(record.usage) }),
})

export const toAdminUser = (record: UserRecord): AdminUser => ({
    id: record._id.toString(),
    createdAt: getCreatedAt(record),
    email: record.isAnonymous ? null : record.email,
    isAnonymous: Boolean(record.isAnonymous),
    emailVerified: Boolean(record.emailVerified),
    isAdmin: Boolean(record.isAdmin),
})
