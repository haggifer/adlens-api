import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { Advisory, AnalysisSettings, Finding, MetadataCheck } from 'adlens-types'

import { resolveRef, ruleSetSchema, type Rule, type RuleSet } from '@/rules/schema'

const ASPECT_RATIO_TOLERANCE = 0.02

let cached: RuleSet | null = null

export const loadRuleSet = (): RuleSet => {
    if (cached) {
        return cached
    }

    const path = fileURLToPath(new URL('./rules.json', import.meta.url))
    cached = ruleSetSchema.parse(JSON.parse(readFileSync(path, 'utf8')))

    return cached
}

export interface SelectedRules {
    content: Rule[]
    metadata: Rule[]
    advisory: Rule[]
}

// Filter to the rules relevant to this video: the user's platforms plus cross-platform ('all')
// regulator rules, restricted to video/all creatives, then split by how each is checked (§6).
export const selectRules = (settings: AnalysisSettings): SelectedRules => {
    const { rules } = loadRuleSet()
    const selectedPlatforms = new Set<string>(settings.platform)

    const relevant = rules.filter((rule) => {
        const appliesToVideo = rule.appliesTo === 'video' || rule.appliesTo === 'all'
        const platformMatch = rule.platform.includes('all') || rule.platform.some((p) => selectedPlatforms.has(p))

        return appliesToVideo && platformMatch
    })

    return {
        content: relevant.filter((r) => r.modality === 'text' || r.modality === 'visual' || r.modality === 'audiovisual'),
        metadata: relevant.filter((r) => r.modality === 'metadata'),
        advisory: relevant.filter((r) => r.modality === 'out_of_creative'),
    }
}

export interface RuleProjection {
    id: string
    check: string
    severity: Rule['severity']
    modality: Rule['modality']
}

// Lean projection sent to the model — quote + ref are attached back by id when rendering (§7.8).
export const projectForModel = (rules: Rule[]): RuleProjection[] =>
    rules.map(({ id, check, severity, modality }) => ({ id, check, severity, modality }))

export const resolveCitation = (rule: Rule): { quote: string; ref: string } => {
    const { sources } = loadRuleSet()

    return { quote: rule.quote, ref: resolveRef(rule.ref, sources) }
}

export interface MediaFacts {
    durationS: number
    width?: number
    height?: number
    fileSize?: number
}

const evaluateMetadataRule = (rule: Rule, media: MediaFacts): Pick<MetadataCheck, 'verdict' | 'detail'> => {
    const { value, unit } = rule

    if (value === undefined) {
        return { verdict: 'unknown', detail: 'Rule has no threshold to check against' }
    }

    switch (rule.checkType) {
        case 'duration_max': {
            const over = media.durationS > value

            return { verdict: over ? 'fail' : 'pass', detail: `Duration ${media.durationS.toFixed(1)}s vs max ${value}${unit}` }
        }
        case 'duration_min': {
            const under = media.durationS < value

            return { verdict: under ? 'fail' : 'pass', detail: `Duration ${media.durationS.toFixed(1)}s vs min ${value}${unit}` }
        }
        case 'resolution_min': {
            if (media.height === undefined) {
                return { verdict: 'unknown', detail: 'Video height unavailable' }
            }

            const under = media.height < value

            return { verdict: under ? 'fail' : 'pass', detail: `Height ${media.height}px vs min ${value}${unit}` }
        }
        case 'filesize_max': {
            if (media.fileSize === undefined) {
                return { verdict: 'unknown', detail: 'File size unavailable' }
            }

            const maxBytes = value * 1000 * 1000
            const over = media.fileSize > maxBytes

            return {
                verdict: over ? 'fail' : 'pass',
                detail: `Size ${(media.fileSize / (1000 * 1000)).toFixed(1)}MB vs max ${value}${unit}`,
            }
        }
        case 'aspect_ratio_in': {
            if (media.width === undefined || media.height === undefined || media.height === 0) {
                return { verdict: 'unknown', detail: 'Video dimensions unavailable' }
            }

            const ratio = media.width / media.height
            const required = typeof rule.params?.ratio === 'string' ? rule.params.ratio : `${value}`
            const off = Math.abs(ratio - value) > ASPECT_RATIO_TOLERANCE

            return { verdict: off ? 'fail' : 'pass', detail: `Aspect ${ratio.toFixed(3)} vs required ${required}` }
        }
        default:
            return { verdict: 'unknown', detail: 'Unsupported metadata check' }
    }
}

export const evaluateMetadataRules = (rules: Rule[], media: MediaFacts): MetadataCheck[] =>
    rules.map((rule) => {
        const { verdict, detail } = evaluateMetadataRule(rule, media)
        const { quote, ref } = resolveCitation(rule)

        return { id: rule.id, topic: rule.topic, severity: rule.severity, verdict, detail, quote, ref }
    })

export const buildAdvisories = (rules: Rule[]): Advisory[] =>
    rules.map((rule) => {
        const { quote, ref } = resolveCitation(rule)

        return { id: rule.id, platform: rule.platform, topic: rule.topic, severity: rule.severity, check: rule.check, quote, ref }
    })

export interface ModelFinding {
    id: string
    verdict: Finding['verdict']
    evidence: string
    timestamp?: string
}

// Map the model's per-rule verdicts back to full findings, attaching rule metadata + citation by id.
// Ids the model returns that aren't in the sent set are dropped (hallucination guard).
export const buildFindings = (contentRules: Rule[], modelFindings: ModelFinding[]): Finding[] => {
    const byId = new Map(contentRules.map((rule) => [rule.id, rule]))

    return modelFindings.flatMap((finding) => {
        const rule = byId.get(finding.id)

        if (!rule) {
            return []
        }

        const { quote, ref } = resolveCitation(rule)

        return [
            {
                id: rule.id,
                platform: rule.platform,
                topic: rule.topic,
                scope: rule.scope,
                severity: rule.severity,
                verdict: finding.verdict,
                evidence: finding.evidence,
                timestamp: finding.timestamp,
                quote,
                ref,
            },
        ]
    })
}
