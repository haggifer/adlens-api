import {
    analysisSchema,
    analysisSettingsSchema,
    jobErrorCodeSchema,
    jobMediaSchema,
    JobStatus,
    jobStatusSchema,
    uploadFileSchema,
} from 'adlens-shared'
import type { Types } from 'mongoose'
import { z } from 'zod'
import { zodToMongoose } from '../common/zod-to-mongoose'

export const JOB_MODEL = 'Job'

export const tokenUsageSchema = z.object({
    promptTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
})

// The stored job: the public shape plus server-only fields (owner, storage location, execution, accounting). Built
// from the shared building blocks so field shapes have a single source.
export const jobDocSchema = z.object({
    userId: z.string(),
    status: jobStatusSchema.default(JobStatus.Pending),
    settings: analysisSettingsSchema,
    file: z.object({ ...uploadFileSchema.shape, bucket: z.string(), path: z.string() }),
    media: jobMediaSchema.optional(),
    analysis: analysisSchema.optional(),
    errorCode: jobErrorCodeSchema.optional(),
    errorDetail: z.string().optional(),
    execution: z.string().optional(),
    attempts: z.number().int().nonnegative().default(0),
    // The quota run this job was charged for; null when nothing is charged (never charged, or refunded).
    chargedRunId: z.string().nullable(),
    // The network's run (IpQuotaService) this job was charged for; null when none is held (admins are never charged).
    chargedIpRunId: z.string().nullable(),
    // Set at creation when a Turnstile check passed; analyze relies on it for the network rules.
    hasPassedChallenge: z.boolean().default(false),
    usage: tokenUsageSchema.optional(),
    // Set when the job analyzes a published sample; its file then points at the sample's object, never a user upload.
    sampleId: z.string().optional(),
})

export type JobDoc = z.infer<typeof jobDocSchema>
export type TokenUsage = z.infer<typeof tokenUsageSchema>

export interface StoredJob extends JobDoc {
    _id: Types.ObjectId
    createdAt: Date
    updatedAt: Date
}

export const JobSchema = zodToMongoose(jobDocSchema, { timestamps: true, collection: 'jobs' })
JobSchema.index({ userId: 1, _id: -1 })
JobSchema.index({ status: 1, updatedAt: 1 })
