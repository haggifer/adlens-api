import {
    type Advisory,
    type AnalysisSettings,
    type Finding,
    type JobMedia,
    type MetadataCheck,
    RulePlatform,
    type TimeRange,
} from 'adlens-shared'
import { resolveRef, type Rule, RULE_PLATFORMS, type RuleSet } from './schema'

const ASPECT_RATIO_TOLERANCE = 0.02

export interface SelectedRules {
    content: Rule[]
    metadata: Rule[]
    advisory: Rule[]
}

export interface RuleProjection {
    id: string
    check: string
    severity: Rule['severity']
    modality: Rule['modality']
}

export interface ModelFinding {
    id: string
    verdict: Finding['verdict']
    evidence: string
    time?: TimeRange
}

const rulePlatformsFor = (settings: AnalysisSettings): Set<RulePlatform> =>
    new Set([RulePlatform.All, ...settings.platforms.flatMap((platform) => RULE_PLATFORMS[platform])])

// The rules relevant to this video: its platforms (plus cross-platform `all` rules), limited to video creatives, to the
// selected markets (global rules always apply) and, for placement-specific rules, to the selected placements. Then
// split by how each one is checked.
export const selectRules = (ruleSet: RuleSet, settings: AnalysisSettings): SelectedRules => {
    const platforms = rulePlatformsFor(settings)
    const markets = new Set<string>(settings.markets)
    const placements = new Set(settings.placements)
    const relevant = ruleSet.rules.filter(
        (rule) =>
            rule.appliesTo !== 'image' &&
            rule.platform.some((platform) => platforms.has(platform)) &&
            (rule.region === 'global' || markets.has(rule.region)) &&
            (!rule.placements || rule.placements.some((placement) => placements.has(placement))),
    )

    return {
        content: relevant.filter(
            (r) => r.modality === 'text' || r.modality === 'visual' || r.modality === 'audiovisual',
        ),
        metadata: relevant.filter((r) => r.modality === 'metadata'),
        advisory: relevant.filter((r) => r.modality === 'out_of_creative'),
    }
}

// The lean projection sent to the model; quote and ref are attached back by id afterwards.
export const projectForModel = (rules: Rule[]): RuleProjection[] =>
    rules.map(({ id, check, severity, modality }) => ({ id, check, severity, modality }))

const citationOf = (ruleSet: RuleSet, rule: Rule): { quote: string; ref: string } => ({
    quote: rule.quote,
    ref: resolveRef(rule.ref, ruleSet.sources),
})

const evaluateMetadataRule = (rule: Rule, media: JobMedia): Pick<MetadataCheck, 'verdict' | 'detail'> => {
    const { value, unit } = rule

    if (value === undefined) {
        return { verdict: 'unknown', detail: 'Rule has no threshold to check against' }
    }

    switch (rule.checkType) {
        case 'duration_max': {
            const isOver = media.durationS > value

            return {
                verdict: isOver ? 'fail' : 'pass',
                detail: `Duration ${media.durationS.toFixed(1)}s vs max ${value}${unit}`,
            }
        }
        case 'duration_min': {
            const isUnder = media.durationS < value

            return {
                verdict: isUnder ? 'fail' : 'pass',
                detail: `Duration ${media.durationS.toFixed(1)}s vs min ${value}${unit}`,
            }
        }
        case 'resolution_min': {
            if (media.height === undefined) {
                return { verdict: 'unknown', detail: 'Video height unavailable' }
            }

            const isUnder = media.height < value

            return { verdict: isUnder ? 'fail' : 'pass', detail: `Height ${media.height}px vs min ${value}${unit}` }
        }
        case 'filesize_max': {
            const isOver = media.sizeBytes > value * 1000 * 1000

            return {
                verdict: isOver ? 'fail' : 'pass',
                detail: `Size ${(media.sizeBytes / (1000 * 1000)).toFixed(1)}MB vs max ${value}${unit}`,
            }
        }
        case 'aspect_ratio_in': {
            if (media.width === undefined || media.height === undefined) {
                return { verdict: 'unknown', detail: 'Video dimensions unavailable' }
            }

            const ratio = media.width / media.height
            const required = typeof rule.params?.ratio === 'string' ? rule.params.ratio : `${value}`
            const isOff = Math.abs(ratio - value) > ASPECT_RATIO_TOLERANCE

            return { verdict: isOff ? 'fail' : 'pass', detail: `Aspect ${ratio.toFixed(3)} vs required ${required}` }
        }
        default:
            return { verdict: 'unknown', detail: 'Unsupported metadata check' }
    }
}

export const evaluateMetadataRules = (ruleSet: RuleSet, rules: Rule[], media: JobMedia): MetadataCheck[] =>
    rules.map((rule) => ({
        id: rule.id,
        topic: rule.topic,
        severity: rule.severity,
        ...evaluateMetadataRule(rule, media),
        ...citationOf(ruleSet, rule),
    }))

export const buildAdvisories = (ruleSet: RuleSet, rules: Rule[]): Advisory[] =>
    rules.map((rule) => ({
        id: rule.id,
        platform: rule.platform,
        topic: rule.topic,
        severity: rule.severity,
        check: rule.check,
        ...citationOf(ruleSet, rule),
    }))

// Maps the model's verdicts back to full findings by rule id. Ids that weren't sent are dropped (hallucination guard).
export const buildFindings = (ruleSet: RuleSet, contentRules: Rule[], modelFindings: ModelFinding[]): Finding[] => {
    const byId = new Map(contentRules.map((rule) => [rule.id, rule]))

    return modelFindings.flatMap((finding) => {
        const rule = byId.get(finding.id)

        if (!rule) {
            return []
        }

        return [
            {
                id: rule.id,
                platform: rule.platform,
                topic: rule.topic,
                scope: rule.scope,
                severity: rule.severity,
                verdict: finding.verdict,
                evidence: finding.evidence,
                time: finding.time,
                ...citationOf(ruleSet, rule),
            },
        ]
    })
}
