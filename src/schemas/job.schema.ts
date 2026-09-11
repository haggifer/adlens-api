import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import type { Analysis, AnalysisSettings, JobFile, JobMedia, JobStatus } from 'adlens-shared'
import { HydratedDocument } from 'mongoose'

export type JobDocument = HydratedDocument<Job>

@Schema({ timestamps: true, collection: 'jobs' })
export class Job {
    @Prop({ type: String, required: true, index: true })
    userId: string

    @Prop({ type: String, required: true, default: 'pending' })
    status: JobStatus

    @Prop({ type: Object, required: true })
    settings: AnalysisSettings

    @Prop({ type: Object, default: null })
    file: JobFile | null

    @Prop({ type: Object })
    media?: JobMedia

    @Prop({ type: Object })
    analysis?: Analysis

    @Prop({ type: String })
    error?: string
}

export const JobSchema = SchemaFactory.createForClass(Job)
JobSchema.index({ userId: 1, createdAt: -1 })
