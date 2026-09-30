import { type AnalysisSettings, type JobMedia, Market, Placement, Platform, RulePlatform } from 'adlens-shared'
import { TEST_RULESET } from '../testing/test-ruleset'
import { evaluateMetadataRules, projectForModel, selectRules } from './index'
import type { Rule } from './schema'

const ruleSet = TEST_RULESET

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

describe('selectRules', () => {
    it('checks every platform’s rules when no platform is chosen', () => {
        const noPlatform = selectedIds(settingsFor({}))
        const everyPlatform = selectedIds(settingsFor({ platforms: Object.values(Platform) }))

        expect(noPlatform.size).toBeGreaterThan(0)
        expect(noPlatform).toEqual(everyPlatform)
    })

    it('checks every market’s rules when no market is chosen', () => {
        const regionalRules = ruleSet.rules.filter((rule) => rule.region !== 'global').map((rule) => rule.id)
        const noMarket = selectedIds(settingsFor({ platforms: [Platform.Meta] }))

        expect(regionalRules.length).toBeGreaterThan(0)
        expect(regionalRules.filter((id) => !noMarket.has(id))).toEqual([])
    })

    it('still applies placement-specific rules only when their placement is chosen', () => {
        const placementRules = ruleSet.rules.filter((rule) => rule.placements).map((rule) => rule.id)
        const nothingChosen = selectedIds(settingsFor({}))

        expect(placementRules.length).toBeGreaterThan(0)
        expect(placementRules.filter((id) => nothingChosen.has(id))).toEqual([])
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

describe('projectForModel', () => {
    const base = ruleSet.rules.find((rule) => rule.id === 'meta.prohibited.adult_nudity_imagery')!
    const ruleOf = (id: string, scope: Rule['scope'], severity: Rule['severity']): Rule => ({
        ...base,
        id,
        scope,
        severity,
    })

    // With a long list the model worked through it in order and skipped blocker policies listed after best-practice
    // tips (Manforce's adult imagery under Meta and TikTok: 0 of 3 runs in list order, 3 of 3 sorted).
    it('puts policies that block an ad first and best-practice advice last', () => {
        const rules = [
            ruleOf('tip', 'best_practice', 'warning'),
            ruleOf('note', 'compliance', 'info'),
            ruleOf('caution', 'compliance', 'warning'),
            ruleOf('ban', 'compliance', 'blocker'),
        ]

        expect(projectForModel(rules).map((rule) => rule.id)).toEqual(['ban', 'caution', 'note', 'tip'])
    })

    it('keeps the given order among rules of equal importance', () => {
        const rules = [ruleOf('b', 'compliance', 'blocker'), ruleOf('a', 'compliance', 'blocker')]

        expect(projectForModel(rules).map((rule) => rule.id)).toEqual(['b', 'a'])
    })
})

describe('evaluateMetadataRules', () => {
    // Amazon Sponsored Brands video: 6 to 45 seconds, 16:9, at least 720px high, at most 500MB.
    const MEDIA: JobMedia = {
        durationS: 20,
        width: 1920,
        height: 1080,
        hasAudio: true,
        sizeBytes: 100_000_000,
        contentType: 'video/mp4',
    }
    const BYTES_PER_MB = 1000 * 1000

    const checkOf = (ruleId: string, media: Partial<JobMedia>) => {
        const rule = ruleSet.rules.find((candidate) => candidate.id === ruleId)!
        const [check] = evaluateMetadataRules(ruleSet, [rule], { ...MEDIA, ...media })

        return check
    }

    const verdictOf = (ruleId: string, media: Partial<JobMedia>) => checkOf(ruleId, media).verdict

    it('passes a duration at its limits and fails one past them', () => {
        expect(verdictOf('amazon.creative_spec.video_max_length', { durationS: 45 })).toBe('pass')
        expect(verdictOf('amazon.creative_spec.video_max_length', { durationS: 45.1 })).toBe('fail')
        expect(verdictOf('amazon.creative_spec.video_min_length', { durationS: 6 })).toBe('pass')
        expect(verdictOf('amazon.creative_spec.video_min_length', { durationS: 5.9 })).toBe('fail')
    })

    it('checks the height against the minimum, and says so when the height is unknown', () => {
        expect(verdictOf('amazon.creative_spec.video_resolution_min', { height: 720 })).toBe('pass')
        expect(verdictOf('amazon.creative_spec.video_resolution_min', { height: 719 })).toBe('fail')
        expect(verdictOf('amazon.creative_spec.video_resolution_min', { height: undefined })).toBe('unknown')
    })

    it('measures the file size in decimal megabytes', () => {
        expect(verdictOf('amazon.creative_spec.video_filesize_max', { sizeBytes: 500 * BYTES_PER_MB })).toBe('pass')
        expect(verdictOf('amazon.creative_spec.video_filesize_max', { sizeBytes: 500 * BYTES_PER_MB + 1 })).toBe('fail')
    })

    it('accepts an aspect ratio within the tolerance only, and says so when the dimensions are unknown', () => {
        const rule = 'amazon.creative_spec.video_aspect_ratio'

        expect(verdictOf(rule, { width: 1920, height: 1080 })).toBe('pass')
        expect(verdictOf(rule, { width: 1432, height: 800 })).toBe('pass')
        expect(verdictOf(rule, { width: 1440, height: 800 })).toBe('fail')
        expect(verdictOf(rule, { width: 1080, height: 1920 })).toBe('fail')
        expect(verdictOf(rule, { width: undefined, height: 1080 })).toBe('unknown')
    })

    describe('for a platform that accepts several ratios', () => {
        // TikTok in-feed: 9:16, 1:1 or 16:9.
        const rule: Rule = {
            ...ruleSet.rules.find((candidate) => candidate.id === 'amazon.creative_spec.video_aspect_ratio')!,
            checkType: 'aspect_ratio_one_of',
            value: undefined,
            params: { ratios: ['9:16', '1:1', '16:9'] },
        }
        const checkWith = (media: Partial<JobMedia>) =>
            evaluateMetadataRules(ruleSet, [rule], { ...MEDIA, ...media })[0]

        it('passes any listed ratio within the tolerance', () => {
            expect(checkWith({ width: 1080, height: 1920 }).verdict).toBe('pass')
            expect(checkWith({ width: 1440, height: 1440 }).verdict).toBe('pass')
            expect(checkWith({ width: 1432, height: 800 }).verdict).toBe('pass')
        })

        it('fails a ratio that is not listed, naming the allowed ones', () => {
            expect(checkWith({ width: 1080, height: 1350 })).toMatchObject({
                verdict: 'fail',
                detail: 'Aspect 0.800 vs allowed 9:16, 1:1, 16:9',
            })
        })

        it('says so when the dimensions are unknown', () => {
            expect(checkWith({ width: undefined }).verdict).toBe('unknown')
        })
    })

    describe('for a platform that accepts a range of ratios', () => {
        // Pinterest standard video: anything from 1:2 to 1.91:1.
        const rule: Rule = {
            ...ruleSet.rules.find((candidate) => candidate.id === 'amazon.creative_spec.video_aspect_ratio')!,
            checkType: 'aspect_ratio_between',
            value: undefined,
            params: { min: '1:2', max: '1.91:1' },
        }
        const checkWith = (media: Partial<JobMedia>) =>
            evaluateMetadataRules(ruleSet, [rule], { ...MEDIA, ...media })[0]

        it('passes the bounds and anything between them', () => {
            expect(checkWith({ width: 1000, height: 2000 }).verdict).toBe('pass')
            expect(checkWith({ width: 1910, height: 1000 }).verdict).toBe('pass')
            expect(checkWith({ width: 1080, height: 1350 }).verdict).toBe('pass')
        })

        it('fails a ratio outside the range, naming the range', () => {
            expect(checkWith({ width: 900, height: 2000 }).verdict).toBe('fail')
            expect(checkWith({ width: 2000, height: 1000 })).toMatchObject({
                verdict: 'fail',
                detail: 'Aspect 2.000 vs allowed 1:2 to 1.91:1',
            })
        })

        it('says so when the dimensions are unknown', () => {
            expect(checkWith({ height: undefined }).verdict).toBe('unknown')
        })
    })

    it('cites the rule, with its source resolved to a link', () => {
        expect(checkOf('amazon.creative_spec.video_max_length', {})).toMatchObject({
            id: 'amazon.creative_spec.video_max_length',
            quote: 'Between 6 and 45 seconds (20 secs or less highly recommended)',
            ref: expect.stringMatching(/^https:\/\/advertising\.amazon\.com\/resources\/ad-specs\//),
        })
    })
})
