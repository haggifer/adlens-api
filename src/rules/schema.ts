import {
    PLACEMENT_PLATFORM,
    placementSchema,
    Platform,
    RulePlatform,
    rulePlatformSchema,
    ruleScopeSchema,
    severitySchema,
} from 'adlens-shared'
import { z } from 'zod'

// The rule platforms whose policies govern ads on each platform. YouTube ads are bought and reviewed through Google
// Ads, so Google Ads policy applies to them too.
export const RULE_PLATFORMS: Record<Platform, RulePlatform[]> = {
    [Platform.Meta]: [RulePlatform.Meta],
    [Platform.TikTok]: [RulePlatform.TikTok],
    [Platform.YouTube]: [RulePlatform.YouTube, RulePlatform.Google],
    [Platform.Snapchat]: [RulePlatform.Snapchat],
    [Platform.Pinterest]: [RulePlatform.Pinterest],
    [Platform.LinkedIn]: [RulePlatform.LinkedIn],
    [Platform.Amazon]: [RulePlatform.Amazon],
}

// A ratio as the platforms write it, width:height ("9:16", "1.91:1").
const aspectRatioSchema = z
    .string()
    .regex(/^\d+(\.\d+)?:\d+(\.\d+)?$/)
    .refine((label) => label.split(':').every((part) => Number(part) > 0), { message: 'both parts must be positive' })

// Platforms that accept several ratios (TikTok: 9:16, 1:1 or 16:9) or a range (Pinterest: 1:2 to 1.91:1) keep them in
// `params`; a single required ratio stays `aspect_ratio_in` with `value`.
export const aspectRatioListParamsSchema = z.object({ ratios: z.array(aspectRatioSchema).min(1) })
export const aspectRatioRangeParamsSchema = z
    .object({ min: aspectRatioSchema, max: aspectRatioSchema })
    .refine(({ min, max }) => toRatio(min) <= toRatio(max), { message: 'min must not be above max' })

// A minimum resolution is on the short side (`value`); TikTok asks more of a square video (640×640 against 540 on the
// short side otherwise), so `squareMin` may raise it for squares.
export const resolutionParamsSchema = z.strictObject({ squareMin: z.number().int().positive() }).partial()

const RATIO_PARAMS_SCHEMAS: Partial<Record<string, z.ZodType>> = {
    aspect_ratio_one_of: aspectRatioListParamsSchema,
    aspect_ratio_between: aspectRatioRangeParamsSchema,
}

// One rule, as authored in a ruleset file and as stored in every published ruleset version.
export const ruleSchema = z
    .object({
        id: z.string().regex(/^[a-z0-9]+(\.[a-z0-9_]+)+$/),
        platform: z.array(rulePlatformSchema).min(1),
        // Limits the rule to these placements (e.g. a bumper-only duration cap); absent means every placement.
        placements: z.array(placementSchema).min(1).optional(),
        region: z.enum(['global', 'US', 'UK', 'EU']),
        scope: ruleScopeSchema,
        appliesTo: z.enum(['video', 'image', 'all']),
        topic: z.string().regex(/^[a-z_]+(:[a-z_]+)?$/),
        modality: z.enum(['metadata', 'text', 'visual', 'audiovisual', 'out_of_creative']),
        checkType: z.enum([
            'judgment',
            'duration_max',
            'duration_min',
            'aspect_ratio_in',
            'aspect_ratio_one_of',
            'aspect_ratio_between',
            'filesize_max',
            'resolution_min',
        ]),
        check: z.string().min(1),
        severity: severitySchema,
        quote: z.string().min(1),
        ref: z.string().regex(/^\{\{[A-Z0-9_]+\}\}(\/|#).*/),
        value: z.number().optional(),
        unit: z.string().optional(),
        params: z.record(z.string(), z.unknown()).optional(),
        weight: z.number().int().min(1).max(5).optional(),
    })
    .refine((r) => r.checkType !== 'resolution_min' || resolutionParamsSchema.optional().safeParse(r.params).success, {
        message: "a resolution_min rule's params may only hold squareMin, a positive whole number of pixels",
    })
    .refine((r) => (r.modality === 'metadata') === (r.checkType !== 'judgment'), {
        message: 'metadata rules need a deterministic checkType; all others must be judgment',
    })
    .refine((r) => r.modality !== 'metadata' || (r.unit !== undefined && hasThreshold(r)), {
        message: 'metadata rules need a unit and a threshold: value, or the ratios in params for a list or range',
    })
    .refine(
        (r) =>
            (r.placements ?? []).every((placement) =>
                RULE_PLATFORMS[PLACEMENT_PLATFORM[placement]].some((platform) => r.platform.includes(platform)),
            ),
        { message: "a rule's placements must belong to its platforms" },
    )

const ruleSourceSchema = z.object({ baseUrl: z.url(), label: z.string(), fetchedAt: z.string() })

export const ruleSetSchema = z
    .object({
        meta: z.object({ rulesetId: z.string(), version: z.string(), generatedAt: z.string() }),
        sources: z.record(z.string(), ruleSourceSchema),
        rules: z.array(ruleSchema).min(1),
    })
    .superRefine((set, ctx) => {
        const ids = new Set<string>()

        for (const r of set.rules) {
            const key = r.ref.match(/^\{\{([A-Z0-9_]+)\}\}/)?.[1]

            if (key && !set.sources[key]) {
                ctx.addIssue({ code: 'custom', message: `ref uses unknown source ${key} in ${r.id}` })
            }

            // The model's findings and the report are matched to rules by id.
            if (ids.has(r.id)) {
                ctx.addIssue({ code: 'custom', message: `duplicate rule id ${r.id}` })
            }

            ids.add(r.id)
        }
    })

export type Rule = z.infer<typeof ruleSchema>
type RuleSource = z.infer<typeof ruleSourceSchema>
export type RuleSet = z.infer<typeof ruleSetSchema>

const hasThreshold = ({ checkType, value, params }: { checkType: string; value?: number; params?: unknown }) => {
    const paramsSchema = RATIO_PARAMS_SCHEMAS[checkType]

    return paramsSchema ? paramsSchema.safeParse(params).success : value !== undefined
}

export const toRatio = (label: string): number => {
    const [width, height] = label.split(':').map(Number)

    return width / height
}

export const resolveRef = (ref: string, sources: Record<string, RuleSource>): string =>
    ref.replace(/^\{\{([A-Z0-9_]+)\}\}/, (_, key) => sources[key]?.baseUrl ?? `{{${key}}}`)
