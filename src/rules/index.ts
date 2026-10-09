import {
    type Advisory,
    type AnalysisSettings,
    type Finding,
    type JobMedia,
    Market,
    type MetadataCheck,
    Placement,
    PLACEMENT_PLATFORM,
    Platform,
    RulePlatform,
    type TimeRange,
} from 'adlens-shared'
import {
    aspectRatioListParamsSchema,
    aspectRatioRangeParamsSchema,
    resolveRef,
    type Rule,
    RULE_PLATFORMS,
    type RuleSet,
    toRatio,
} from './schema'

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

// Advisory rules are never judged; the model only says which ones this ad falls under.
export interface AdvisoryProjection {
    id: string
    check: string
}

export interface ModelFinding {
    id: string
    verdict: Finding['verdict']
    evidence: string
    time?: TimeRange
}

interface RuleFilter {
    platforms: Set<RulePlatform>
    markets: Set<string>
    placements: Set<Placement>
}

type MetadataVerdict = Pick<MetadataCheck, 'verdict' | 'detail'>

const ASPECT_RATIO_TOLERANCE = 0.02
// Encoders round a video to whole frames and containers add a few milliseconds, so a 6-second bumper probes at 6.02 to
// 6.04 s; a tenth of a second covers that without letting a visibly longer video through.
const DURATION_TOLERANCE_S = 0.1
// Decimal megabytes, as the platforms state their file-size limits.
const BYTES_PER_MB = 1000 * 1000

const SCOPE_RANK: Record<Rule['scope'], number> = { compliance: 0, best_practice: 1 }
const SEVERITY_RANK: Record<Rule['severity'], number> = { blocker: 0, warning: 1, info: 2 }

const rulePlatformsFor = (platforms: Platform[]): Set<RulePlatform> =>
    new Set([RulePlatform.All, ...platforms.flatMap((platform) => RULE_PLATFORMS[platform])])

const toRuleFilter = (settings: AnalysisSettings): RuleFilter => ({
    platforms: rulePlatformsFor(settings.platforms),
    markets: new Set<string>(settings.markets),
    placements: new Set(settings.placements),
})

const isRelevant = (rule: Rule, { platforms, markets, placements }: RuleFilter): boolean =>
    rule.appliesTo !== 'image' &&
    rule.platform.some((platform) => platforms.has(platform)) &&
    (rule.region === 'global' || markets.has(rule.region)) &&
    (!rule.placements || rule.placements.some((placement) => placements.has(placement)))

const citationOf = (ruleSet: RuleSet, rule: Rule): { quote: string; ref: string } => ({
    quote: rule.quote,
    ref: resolveRef(rule.ref, ruleSet.sources),
})

// null when the prober couldn't read the video's dimensions.
const getAspectRatio = (media: JobMedia): number | null =>
    media.width === undefined || media.height === undefined ? null : media.width / media.height

// "30.4 seconds": one decimal at most, none for whole seconds.
const formatSeconds = (seconds: number, decimals = 1) => `${Number(seconds.toFixed(decimals))} seconds`

// Two decimals when one would round the duration to the limit itself, so "It’s 6 seconds long" never sits next to a
// 6-second limit it was measured against as different.
const formatDuration = (seconds: number, limit: number) =>
    formatSeconds(seconds, Number(seconds.toFixed(1)) === limit ? 2 : 1)

const formatSize = (media: JobMedia) => `${media.width}×${media.height}`

const evaluateAspectRatio = (rule: Rule, media: JobMedia): MetadataVerdict => {
    const ratio = getAspectRatio(media)

    if (ratio === null) {
        return { verdict: 'unknown', detail: 'Its dimensions couldn’t be read.' }
    }

    const size = formatSize(media)

    if (rule.checkType === 'aspect_ratio_one_of') {
        const { ratios } = aspectRatioListParamsSchema.parse(rule.params)
        const isListed = ratios.some((label) => Math.abs(ratio - toRatio(label)) <= ASPECT_RATIO_TOLERANCE)
        const allowed = ratios.join(', ')

        return isListed
            ? { verdict: 'pass', detail: `It’s ${size}, one of the shapes allowed: ${allowed}.` }
            : { verdict: 'fail', detail: `It’s ${size}, none of the shapes allowed: ${allowed}.` }
    }

    const { min, max } = aspectRatioRangeParamsSchema.parse(rule.params)
    const isInRange = ratio >= toRatio(min) - ASPECT_RATIO_TOLERANCE && ratio <= toRatio(max) + ASPECT_RATIO_TOLERANCE

    return isInRange
        ? { verdict: 'pass', detail: `It’s ${size}, within the shapes allowed: ${min} to ${max}.` }
        : { verdict: 'fail', detail: `It’s ${size}, outside the shapes allowed: ${min} to ${max}.` }
}

// The rule's platforms the selected ones reach; all of them when none were given.
const narrowPlatforms = (rule: Rule, selectedPlatforms: Platform[] | undefined): RulePlatform[] => {
    if (!selectedPlatforms) {
        return rule.platform
    }

    const reached = rulePlatformsFor(selectedPlatforms)
    const narrowed = rule.platform.filter((platform) => reached.has(platform))

    return narrowed.length ? narrowed : rule.platform
}

// The details are sentences the report shows as they are, about the video ("It’s 30.4 seconds long, …").
const evaluateMetadataRule = (rule: Rule, media: JobMedia): MetadataVerdict => {
    const { value } = rule

    if (rule.checkType === 'aspect_ratio_one_of' || rule.checkType === 'aspect_ratio_between') {
        return evaluateAspectRatio(rule, media)
    }

    if (value === undefined) {
        return { verdict: 'unknown', detail: 'The rule has no limit to check against.' }
    }

    switch (rule.checkType) {
        case 'duration_max': {
            const length = `It’s ${formatDuration(media.durationS, value)} long`

            return media.durationS > value + DURATION_TOLERANCE_S
                ? { verdict: 'fail', detail: `${length}, longer than the ${formatSeconds(value)} allowed.` }
                : { verdict: 'pass', detail: `${length}, within the ${formatSeconds(value)} allowed.` }
        }
        case 'duration_min': {
            const length = `It’s ${formatDuration(media.durationS, value)} long`

            return media.durationS < value - DURATION_TOLERANCE_S
                ? { verdict: 'fail', detail: `${length}, shorter than the ${formatSeconds(value)} required.` }
                : { verdict: 'pass', detail: `${length}, at least the ${formatSeconds(value)} required.` }
        }
        case 'resolution_min': {
            if (media.height === undefined) {
                return { verdict: 'unknown', detail: 'Its height couldn’t be read.' }
            }

            const height = `It’s ${media.height} px tall`

            return media.height < value
                ? { verdict: 'fail', detail: `${height}, less than the ${value} px required.` }
                : { verdict: 'pass', detail: `${height}, at least the ${value} px required.` }
        }
        case 'filesize_max': {
            const size = `It’s ${Number((media.sizeBytes / BYTES_PER_MB).toFixed(1))} MB`

            return media.sizeBytes > value * BYTES_PER_MB
                ? { verdict: 'fail', detail: `${size}, more than the ${value} MB allowed.` }
                : { verdict: 'pass', detail: `${size}, within the ${value} MB allowed.` }
        }
        case 'aspect_ratio_in': {
            const ratio = getAspectRatio(media)

            if (ratio === null) {
                return { verdict: 'unknown', detail: 'Its dimensions couldn’t be read.' }
            }

            const required = typeof rule.params?.ratio === 'string' ? rule.params.ratio : `${value}`
            const size = formatSize(media)

            return Math.abs(ratio - value) > ASPECT_RATIO_TOLERANCE
                ? { verdict: 'fail', detail: `It’s ${size}, not the ${required} shape required.` }
                : { verdict: 'pass', detail: `It’s ${size}, the ${required} shape required.` }
        }
        default:
            return { verdict: 'unknown', detail: 'This spec can’t be checked automatically.' }
    }
}

// Nothing chosen means nothing ruled out: an empty list stands for every value (placements: every one of the chosen
// platforms'), so leaving a setting empty and choosing all of it select the same rules and read the same in the
// prompt. Two runs of one ad differed only by that (2026-10-08: 6 findings and 18 specs vs 2 and 1).
export const resolveSettings = ({ platforms, placements, markets }: AnalysisSettings): AnalysisSettings => {
    const resolvedPlatforms = platforms.length ? platforms : Object.values(Platform)

    return {
        platforms: resolvedPlatforms,
        placements: placements.length
            ? placements
            : Object.values(Placement).filter((placement) => resolvedPlatforms.includes(PLACEMENT_PLATFORM[placement])),
        markets: markets.length ? markets : Object.values(Market),
    }
}

// The rules relevant to this video: its platforms (plus cross-platform `all` rules), limited to video creatives, to the
// markets (global rules always apply) and, for placement-specific rules, to the placements. Then split by how each one
// is checked.
export const selectRules = (ruleSet: RuleSet, settings: AnalysisSettings): SelectedRules => {
    const filter = toRuleFilter(resolveSettings(settings))
    const relevant = ruleSet.rules.filter((rule) => isRelevant(rule, filter))

    return {
        content: relevant.filter(
            (r) => r.modality === 'text' || r.modality === 'visual' || r.modality === 'audiovisual',
        ),
        metadata: relevant.filter((r) => r.modality === 'metadata'),
        advisory: relevant.filter((r) => r.modality === 'out_of_creative'),
    }
}

// The lean projection sent to the model; quote and ref are attached back by id afterwards. With a long list the model
// works through it in order, so policies that block an ad come first and best-practice advice last; rules of equal
// rank keep their ruleset order.
export const projectForModel = (rules: Rule[]): RuleProjection[] =>
    [...rules]
        .sort(
            (a, b) =>
                SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
        )
        .map(({ id, check, severity, modality }) => ({ id, check, severity, modality }))

export const projectAdvisoriesForModel = (rules: Rule[]): AdvisoryProjection[] =>
    rules.map(({ id, check }) => ({ id, check }))

// A placement-specific rule binds the selected placements among its own (all of them when none was chosen, as in
// resolveSettings); a rule without placements binds its platforms' every placement and names none. A rule spanning
// several platforms names only those the selected platforms reach, so a Meta-only run never reads "won't work on
// YouTube". Pass both lists resolved (resolveSettings); without platforms the rule's own are named.
export const evaluateMetadataRules = (
    ruleSet: RuleSet,
    rules: Rule[],
    media: JobMedia,
    selectedPlacements: Placement[],
    selectedPlatforms?: Platform[],
): MetadataCheck[] =>
    rules.map((rule) => ({
        id: rule.id,
        platform: narrowPlatforms(rule, selectedPlatforms),
        ...(rule.placements && {
            placements: selectedPlacements.length
                ? rule.placements.filter((placement) => selectedPlacements.includes(placement))
                : rule.placements,
        }),
        topic: rule.topic,
        check: rule.check,
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
