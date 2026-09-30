import { Market, Placement, PLACEMENT_PLATFORM, Platform, RulePlatform } from 'adlens-shared'
import { RULE_PLATFORMS, type Rule, type RuleSet } from './schema'

type Row = (string | number)[]

const table = (header: string[], rows: Row[]): string[] => [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
]

const countBy = (rules: Rule[], keysOf: (rule: Rule) => string[]): Map<string, number> => {
    const counts = new Map<string, number>()

    for (const rule of rules) {
        for (const key of keysOf(rule)) {
            counts.set(key, (counts.get(key) ?? 0) + 1)
        }
    }

    return counts
}

// The app options (Platform) whose selection brings a rule platform's rules; `all` rules come with any of them.
const optionsFor = (rulePlatform: string): string =>
    rulePlatform === RulePlatform.All
        ? 'every platform'
        : Object.values(Platform)
              .filter((platform) => RULE_PLATFORMS[platform].some((candidate) => candidate === rulePlatform))
              .join(', ') || '**none: unreachable**'

const MARKET_REGIONS = new Set<string>(Object.values(Market))

// A compact account of a ruleset for keeping the code in sync with it: which options reach its platforms, which
// placements and regions it uses, the check types the API must support, and its sources. Written next to the ruleset
// file on every publish.
export const summarizeRuleSet = (ruleSet: RuleSet, sourceFile: string, generatedOn: string): string => {
    const { rules } = ruleSet
    const byModality = countBy(rules, (rule) => [rule.modality])
    const judged = rules.length - (byModality.get('metadata') ?? 0) - (byModality.get('out_of_creative') ?? 0)
    const byPlatform = countBy(rules, (rule) => rule.platform)
    const byPlacement = countBy(rules, (rule) => rule.placements ?? [])
    const byRegion = countBy(rules, (rule) => [rule.region])
    const byCheckType = countBy(rules, (rule) => [rule.checkType])
    const bySeverity = countBy(rules, (rule) => [rule.severity])
    const unusedPlacements = Object.values(Placement).filter((placement) => !byPlacement.has(placement))
    const unreachable = [...byPlatform.keys()].filter((platform) => optionsFor(platform).includes('unreachable'))
    const regionsWithoutMarket = [...byRegion.keys()].filter(
        (region) => region !== 'global' && !MARKET_REGIONS.has(region),
    )

    return [
        `# Ruleset summary: ${ruleSet.meta.rulesetId} ${ruleSet.meta.version}`,
        '',
        `Generated on ${generatedOn} from \`${sourceFile}\` (ruleset generated ${ruleSet.meta.generatedAt}) by`,
        "`npm run rules:publish` or `npm run rules:summary` in adlens-api. Regenerated on every publish; don't edit.",
        '',
        '## Counts',
        '',
        ...table(
            ['Rules', 'Judged by the model', 'Advisories', 'Metadata (checked in code)', 'Blocker', 'Warning', 'Info'],
            [
                [
                    rules.length,
                    judged,
                    byModality.get('out_of_creative') ?? 0,
                    byModality.get('metadata') ?? 0,
                    bySeverity.get('blocker') ?? 0,
                    bySeverity.get('warning') ?? 0,
                    bySeverity.get('info') ?? 0,
                ],
            ],
        ),
        '',
        '## Rule platforms and the app options that bring them',
        '',
        ...table(
            ['Rule platform', 'Rules', 'App option (Platform)'],
            [...byPlatform.entries()].sort().map(([platform, count]) => [platform, count, optionsFor(platform)]),
        ),
        '',
        '## Placements (every app option)',
        '',
        ...table(
            ['Placement', 'Platform', 'Rules'],
            Object.values(Placement).map((placement) => [
                placement,
                PLACEMENT_PLATFORM[placement],
                byPlacement.get(placement) ?? 0,
            ]),
        ),
        '',
        '## Regions and market options',
        '',
        ...table(
            ['Region', 'Rules', 'Applies with'],
            [...byRegion.entries()]
                .sort()
                .map(([region, count]) => [
                    region,
                    count,
                    region === 'global'
                        ? 'always'
                        : MARKET_REGIONS.has(region)
                          ? `${region} market`
                          : '**no market option**',
                ]),
        ),
        '',
        '## Check types (the deployed API must support every one)',
        '',
        ...table(['Check type', 'Rules'], [...byCheckType.entries()].sort()),
        '',
        '## Sources',
        '',
        ...table(
            ['Key', 'Label', 'Base URL', 'Fetched'],
            Object.entries(ruleSet.sources)
                .sort()
                .map(([key, source]) => [key, source.label, source.baseUrl, source.fetchedAt]),
        ),
        '',
        '## Sync notes',
        '',
        `- Rule platforms no app option reaches: ${unreachable.map((platform) => `\`${platform}\``).join(', ') || 'none'}.`,
        `- Regions without a market option: ${regionsWithoutMarket.map((region) => `\`${region}\``).join(', ') || 'none'}.`,
        `- Placements offered with no rule of their own: ${
            unusedPlacements.map((placement) => `\`${placement}\``).join(', ') || 'none'
        } (they still tell the model where the ad runs).`,
        '',
    ].join('\n')
}
