import { jobDocSchema, type JobDoc } from 'adlens-shared'
import { HydratedDocument } from 'mongoose'
import { zodToMongoose } from '../common/zod-to-mongoose'

export const JOB_MODEL = 'Job'

export type JobDocument = HydratedDocument<JobDoc & { quotaRefunded?: boolean }>

export const JobSchema = zodToMongoose(jobDocSchema, { timestamps: true, collection: 'jobs' })
// Server-internal accounting flag (not part of the shared wire contract): guards refund-at-most-once.
JobSchema.add({ quotaRefunded: { type: Boolean, default: false } })
JobSchema.index({ userId: 1, createdAt: -1 })
