import { type AnalysisSettings, Market, Placement, Platform, RulePlatform } from 'adlens-shared'
import { loadBundledRuleSet } from '../testing/bundled-ruleset'
import { selectRules } from './index'
import { type Rule, RULE_PLATFORMS } from './schema'

const ruleSet = loadBundledRuleSet()

const settingsFor = (overrides: Partial<AnalysisSettings>): AnalysisSettings => ({
    platforms: [],
    placements: [],
    markets: [],
    ...overrides,
})

const selectedIds = (settings: AnalysisSettings): Set<string> => {
    const { content, metadata, advisory } = selectRules(ruleSet, settings)

    return new Set([...content, ...metadata, ...advisory].map((rule) => rule.id))
}

// The narrowest settings under which a rule should apply.
const settingsTargeting = (rule: Rule): AnalysisSettings => {
    const platforms = Object.values(Platform).filter((platform) =>
        RULE_PLATFORMS[platform].some((rulePlatform) => rule.platform.includes(rulePlatform)),
    )

    return settingsFor({
        platforms: rule.platform.includes(RulePlatform.All) ? [Platform.Meta] : platforms,
        placements: rule.placements ?? [],
        markets: rule.region === 'global' ? [] : [rule.region as Market],
    })
}

describe('selectRules', () => {
    it('can reach every video rule from some combination of settings', () => {
        const unreachable = ruleSet.rules
            .filter((rule) => rule.appliesTo !== 'image')
            .filter((rule) => !selectedIds(settingsTargeting(rule)).has(rule.id))
            .map((rule) => rule.id)

        expect(unreachable).toEqual([])
    })

    it('applies the 6-second bumper limit only when the bumper placement is chosen', () => {
        const bumper = 'youtube.creative_spec.bumper_duration'

        expect(selectedIds(settingsFor({ platforms: [Platform.YouTube] })).has(bumper)).toBe(false)
        expect(
            selectedIds(settingsFor({ platforms: [Platform.YouTube], placements: [Placement.YouTubeBumper] })).has(
                bumper,
            ),
        ).toBe(true)
    })

    it('applies market-specific rules only in their market', () => {
        const ukRules = ruleSet.rules.filter((rule) => rule.region === 'UK').map((rule) => rule.id)
        const withoutUk = selectedIds(settingsFor({ platforms: [Platform.Meta], markets: [Market.EU] }))
        const withUk = selectedIds(settingsFor({ platforms: [Platform.Meta], markets: [Market.UK] }))

        expect(ukRules.length).toBeGreaterThan(0)
        expect(ukRules.some((id) => withoutUk.has(id))).toBe(false)
        expect(ukRules.every((id) => withUk.has(id))).toBe(true)
    })

    it('applies Google Ads policy to YouTube ads', () => {
        const googleOnly = ruleSet.rules.find((rule) => rule.platform.join() === RulePlatform.Google)!

        expect(selectedIds(settingsFor({ platforms: [Platform.YouTube] })).has(googleOnly.id)).toBe(true)
        expect(selectedIds(settingsFor({ platforms: [Platform.Meta] })).has(googleOnly.id)).toBe(false)
    })
})
