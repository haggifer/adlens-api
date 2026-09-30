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

const tokenCountSchema = z.number().int().nonnegative()

// Token counts per modality (TEXT, IMAGE, VIDEO, AUDIO, DOCUMENT): some models price audio input apart.
const tokensByModalitySchema = z.record(z.string(), tokenCountSchema)

// One billed Gemini call with everything its price depends on: the model, the endpoint (Vertex prices regional
// endpoints above global), the date (list prices change), the traffic type (on-demand, priority, flex or provisioned)
// and the tokens by kind and modality; a request's own size decides long-context tiers.
export const modelCallSchema = z.object({
    at: z.date(),
    model: z.string(),
    location: z.string(),
    trafficType: z.string().optional(),
    finishReason: z.string().optional(),
    promptTokens: tokenCountSchema,
    cachedTokens: tokenCountSchema,
    toolUsePromptTokens: tokenCountSchema,
    candidatesTokens: tokenCountSchema,
    thoughtsTokens: tokenCountSchema,
    totalTokens: tokenCountSchema,
    promptTokensByModality: tokensByModalitySchema,
    cachedTokensByModality: tokensByModalitySchema,
    candidatesTokensByModality: tokensByModalitySchema,
    toolUsePromptTokensByModality: tokensByModalitySchema,
})

// Every billed call of the job, and totals across them (output = answer + thinking, which bill at one rate). Jobs from
// before the calls were recorded have the totals only.
export const tokenUsageSchema = z.object({
    promptTokens: tokenCountSchema,
    outputTokens: tokenCountSchema,
    totalTokens: tokenCountSchema,
    calls: z.array(modelCallSchema).optional(),
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
export type ModelCall = z.infer<typeof modelCallSchema>

export interface StoredJob extends JobDoc {
    _id: Types.ObjectId
    createdAt: Date
    updatedAt: Date
}

export const JobSchema = zodToMongoose(jobDocSchema, { timestamps: true, collection: 'jobs' })
JobSchema.index({ userId: 1, _id: -1 })
JobSchema.index({ status: 1, updatedAt: 1 })
