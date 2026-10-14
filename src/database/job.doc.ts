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
const modelCallSchema = z.object({
    at: z.date(),
    // Milliseconds the model request took, our parsing excluded; `at` is when the answer arrived. Calls recorded
    // before it was measured have none.
    durationMs: z.number().int().nonnegative().optional(),
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
const tokenUsageSchema = z.object({
    promptTokens: tokenCountSchema,
    outputTokens: tokenCountSchema,
    totalTokens: tokenCountSchema,
    calls: z.array(modelCallSchema).optional(),
})

// Every demo job has this owner, which matches no user, so a demo shows up in nobody's History and no account can
// delete it; only the maintainer's script creates and changes demos.
export const DEMO_OWNER = 'demo'

// Marks a job as one of the demo page's finished analyses, with the copy the page shows for it.
const demoSchema = z.object({
    slug: z.string().regex(/^[a-z0-9-]+$/),
    label: z.string().min(1),
    title: z.string().min(1),
    subtitle: z.string().min(1),
    order: z.number().int().default(0),
    // An inactive demo stays stored but leaves the page.
    isActive: z.boolean().default(true),
})

// The stored job: the public shape plus server-only fields (owner, storage location, execution, accounting). Built
// from the shared building blocks so field shapes have a single source.
const jobDocSchema = z.object({
    userId: z.string(),
    status: jobStatusSchema.default(JobStatus.Pending),
    settings: analysisSettingsSchema,
    file: z.object({ ...uploadFileSchema.shape, bucket: z.string(), path: z.string() }),
    media: jobMediaSchema.optional(),
    analysis: analysisSchema.optional(),
    errorCode: jobErrorCodeSchema.optional(),
    errorDetail: z.string().optional(),
    execution: z.string().optional(),
    // When the verified, charged upload was queued, or a refused Gemini call was cleared: the time limit for starting the
    // call counts from here, whatever the worker writes later. Missing on jobs queued before 2026-10-08.
    queuedAt: z.date().optional(),
    attempts: z.number().int().nonnegative().default(0),
    // Set just before a worker attempt calls Gemini, and cleared only when Vertex refused that call with an HTTP error
    // status (never billed). An attempt that finds it set doesn't call again: the earlier call may have been billed.
    modelCallStartedAt: z.date().optional(),
    // The quota run this job was charged for, recorded just before the charge; null when none is held (never
    // charged, or refunded). On a job that is neither in flight nor analyzed, a held run is a refund still owed.
    chargedRunId: z.string().nullable(),
    // The network's run (IpQuotaService), likewise; null when none is held (admins are never charged).
    chargedIpRunId: z.string().nullable(),
    // Set at creation when a Turnstile check passed; analyze relies on it for the network rules.
    hasPassedChallenge: z.boolean().default(false),
    usage: tokenUsageSchema.optional(),
    // When the daily cleanup deleted the job's video, which backed no results (AbandonedUploadCleanupService).
    videoDeletedAt: z.date().optional(),
    // Set when the job analyzes a published sample; its file then points at the sample's object, never a user upload.
    sampleId: z.string().optional(),
    // Set on a demo job: its file points at a video under demos/, which only the maintainer's script manages.
    demo: demoSchema.optional(),
    // The preset applied when the job was created; the start counts the run for it while the settings still match.
    presetId: z.string().nullable().default(null),
    // The name of the preset the run was counted for, as it was named then; null when it counted for none.
    presetName: z.string().nullable().default(null),
})

export type JobDoc = z.infer<typeof jobDocSchema>
export type JobDemo = z.infer<typeof demoSchema>
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
// The demo page's query; sparse, since all but a few jobs have no demo.
JobSchema.index({ 'demo.isActive': 1, 'demo.order': 1 }, { sparse: true })
// The maintainer's script finds a demo by its slug.
JobSchema.index({ 'demo.slug': 1 }, { sparse: true })
