import { quotaDocSchema, type QuotaDoc } from 'adlens-shared'
import { HydratedDocument } from 'mongoose'
import { zodToMongoose } from '../common/zod-to-mongoose'

export const QUOTA_MODEL = 'Quota'

export type QuotaDocument = HydratedDocument<QuotaDoc>

export const QuotaSchema = zodToMongoose(quotaDocSchema, { collection: 'quotas' })
QuotaSchema.index({ userId: 1 }, { unique: true })
