import { z } from 'zod'

// Validator for the bundled rules.json — see rule_distillation_guide.md §9.
export const ruleSchema = z
    .object({
        id: z.string().regex(/^[a-z0-9]+(\.[a-z0-9_]+)+$/),
        platform: z
            .array(z.enum(['Meta', 'Google', 'YouTube', 'TikTok', 'Snapchat', 'Pinterest', 'LinkedIn', 'Amazon', 'all']))
            .min(1),
        region: z.enum(['global', 'US', 'UK', 'EU']),
        scope: z.enum(['compliance', 'best_practice']),
        appliesTo: z.enum(['video', 'image', 'all']),
        topic: z.string().regex(/^[a-z_]+(:[a-z_]+)?$/),
        modality: z.enum(['metadata', 'text', 'visual', 'audiovisual', 'out_of_creative']),
        checkType: z.enum(['judgment', 'duration_max', 'duration_min', 'aspect_ratio_in', 'filesize_max', 'resolution_min']),
        check: z.string().min(1),
        severity: z.enum(['blocker', 'warning', 'info']),
        quote: z.string().min(1),
        ref: z.string().regex(/^\{\{[A-Z0-9_]+\}\}(\/|#).*/),
        value: z.number().optional(),
        unit: z.string().optional(),
        params: z.record(z.string(), z.unknown()).optional(),
        weight: z.number().int().min(1).max(5).optional(),
    })
    .refine((r) => (r.modality === 'metadata') === (r.checkType !== 'judgment'), {
        message: 'metadata rules need a deterministic checkType; all others must be judgment',
    })
    .refine((r) => r.modality !== 'metadata' || (r.value !== undefined && r.unit !== undefined), {
        message: 'metadata rules need value + unit',
    })

export const ruleSourceSchema = z.object({ baseUrl: z.url(), label: z.string(), fetchedAt: z.string() })

export const ruleSetSchema = z
    .object({
        meta: z.object({ rulesetId: z.string(), version: z.string(), generatedAt: z.string() }),
        sources: z.record(z.string(), ruleSourceSchema),
        rules: z.array(ruleSchema).min(1),
    })
    .superRefine((set, ctx) => {
        for (const r of set.rules) {
            const key = r.ref.match(/^\{\{([A-Z0-9_]+)\}\}/)?.[1]

            if (key && !set.sources[key]) {
                ctx.addIssue({ code: 'custom', message: `ref uses unknown source ${key} in ${r.id}` })
            }
        }
    })

export type Rule = z.infer<typeof ruleSchema>
export type RuleSource = z.infer<typeof ruleSourceSchema>
export type RuleSet = z.infer<typeof ruleSetSchema>

export const resolveRef = (ref: string, sources: Record<string, RuleSource>): string =>
    ref.replace(/^\{\{([A-Z0-9_]+)\}\}/, (_, key) => sources[key]?.baseUrl ?? `{{${key}}}`)
