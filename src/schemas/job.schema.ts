import { jobDocSchema, type JobDoc } from 'adlens-shared'
import { HydratedDocument } from 'mongoose'
import { zodToMongoose } from '../common/zod-to-mongoose'

export const JOB_MODEL = 'Job'

export type JobDocument = HydratedDocument<JobDoc>

export const JobSchema = zodToMongoose(jobDocSchema, { timestamps: true, collection: 'jobs' })
JobSchema.index({ userId: 1, createdAt: -1 })
