import { z } from 'zod'
import { zodToMongoose } from '../common/zod-to-mongoose'
import { ruleSetSchema } from '../rules/schema'

export const RULESET_MODEL = 'Ruleset'
export const RULESET_COLLECTION = 'rulesets'

// One immutable document per published ruleset version. Analyses record the version they ran with, so any past result
// can be traced back to the exact rules behind it.
const rulesetDocSchema = z.object({
    version: z.string(),
    ruleset: ruleSetSchema,
    publishedAt: z.date(),
})

export type RulesetDoc = z.infer<typeof rulesetDocSchema>

export const RulesetSchema = zodToMongoose(rulesetDocSchema, { collection: RULESET_COLLECTION })
RulesetSchema.index({ version: 1 }, { unique: true })
RulesetSchema.index({ publishedAt: -1 })
