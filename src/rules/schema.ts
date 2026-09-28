import {
    PLACEMENT_PLATFORM,
    Platform,
    placementSchema,
    RulePlatform,
    rulePlatformSchema,
    ruleScopeSchema,
    severitySchema,
} from 'adlens-shared'
import { z } from 'zod'

// The rule platforms whose policies govern ads on each platform. YouTube ads are bought and reviewed through Google Ads,
// so Google Ads policy applies to them too.
export const RULE_PLATFORMS: Record<Platform, RulePlatform[]> = {
    [Platform.Meta]: [RulePlatform.Meta],
    [Platform.TikTok]: [RulePlatform.TikTok],
    [Platform.YouTube]: [RulePlatform.YouTube, RulePlatform.Google],
    [Platform.Snapchat]: [RulePlatform.Snapchat],
    [Platform.Pinterest]: [RulePlatform.Pinterest],
    [Platform.LinkedIn]: [RulePlatform.LinkedIn],
    [Platform.Amazon]: [RulePlatform.Amazon],
}

// One rule, as authored in rules.json and as stored in every published ruleset version.
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
    .refine((r) => (r.modality === 'metadata') === (r.checkType !== 'judgment'), {
        message: 'metadata rules need a deterministic checkType; all others must be judgment',
    })
    .refine((r) => r.modality !== 'metadata' || (r.value !== undefined && r.unit !== undefined), {
        message: 'metadata rules need value + unit',
    })
    .refine(
        (r) =>
            (r.placements ?? []).every((placement) =>
                RULE_PLATFORMS[PLACEMENT_PLATFORM[placement]].some((platform) => r.platform.includes(platform)),
            ),
        { message: "a rule's placements must belong to its platforms" },
    )

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
