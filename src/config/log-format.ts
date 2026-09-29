import { z } from 'zod'

// `json` on Cloud Run (infra/setup.sh), where Cloud Logging turns each line into a structured entry. Kept out of
// env.ts, which builds the config module on import: the logger is chosen before Nest starts.
export const logFormatSchema = z.enum(['text', 'json']).default('text')

export type LogFormat = z.infer<typeof logFormatSchema>

export const readLogFormat = (raw: Record<string, unknown>): LogFormat => logFormatSchema.parse(raw.LOG_FORMAT)
