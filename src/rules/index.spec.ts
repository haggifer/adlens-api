import { type AnalysisSettings, type JobMedia, Market, Placement, Platform, RulePlatform } from 'adlens-shared'
import { TEST_RULESET } from '../testing/test-ruleset'
import {
    buildAdvisories,
    buildFindings,
    evaluateMetadataRules,
    projectForModel,
    resolveSettings,
    selectRules,
} from './index'
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

    it('checks every placement’s rules when no placement is chosen', () => {
        const placementRules = ruleSet.rules.filter((rule) => rule.placements).map((rule) => rule.id)
        const nothingChosen = selectedIds(settingsFor({}))

        expect(placementRules.length).toBeGreaterThan(0)
        expect(placementRules.filter((id) => !nothingChosen.has(id))).toEqual([])
    })

    it('selects the same rules when nothing is chosen as when everything is', () => {
        const everything = settingsFor({
            platforms: Object.values(Platform),
            placements: Object.values(Placement),
            markets: Object.values(Market),
        })

        expect(selectedIds(settingsFor({}))).toEqual(selectedIds(everything))
    })

    it('applies the 6-second bumper limit unless other placements were chosen without it', () => {
        const bumper = 'youtube.creative_spec.bumper_duration'
        const withPlacements = (placements: Placement[]) =>
            selectedIds(settingsFor({ platforms: [Platform.YouTube], placements }))

        expect(withPlacements([]).has(bumper)).toBe(true)
        expect(withPlacements([Placement.YouTubeBumper]).has(bumper)).toBe(true)
        expect(withPlacements([Placement.YouTubeShorts]).has(bumper)).toBe(false)
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

describe('resolveSettings', () => {
    it('stands every platform, placement and market for an empty list', () => {
        expect(resolveSettings(settingsFor({}))).toEqual({
            platforms: Object.values(Platform),
            placements: Object.values(Placement),
            markets: Object.values(Market),
        })
    })

    it('stands only the chosen platforms’ placements for an empty placement list', () => {
        expect(resolveSettings(settingsFor({ platforms: [Platform.TikTok, Platform.Amazon] })).placements).toEqual([
            Placement.TikTokInFeed,
            Placement.AmazonSponsoredBrandsVideo,
        ])
    })

    it('stands all of a chosen platform’s placements when none of them was chosen, keeping the others’ choice', () => {
        const resolved = resolveSettings(
            settingsFor({ platforms: [Platform.Meta, Platform.TikTok], placements: [Placement.MetaReels] }),
        )

        expect(resolved.placements).toEqual([Placement.MetaReels, Placement.TikTokInFeed])
    })

    it('keeps what was chosen', () => {
        const chosen = settingsFor({
            platforms: [Platform.Meta],
            placements: [Placement.MetaReels],
            markets: [Market.UK],
        })

        expect(resolveSettings(chosen)).toEqual(chosen)
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
    const SELECTED = [Placement.AmazonSponsoredBrandsVideo]

    const checkOf = (ruleId: string, media: Partial<JobMedia>) => {
        const rule = ruleSet.rules.find((candidate) => candidate.id === ruleId)!
        const [check] = evaluateMetadataRules(ruleSet, [rule], { ...MEDIA, ...media }, SELECTED)

        return check
    }

    const verdictOf = (ruleId: string, media: Partial<JobMedia>) => checkOf(ruleId, media).verdict

    it('passes a duration within a tenth of a second of its limits and fails one further past them', () => {
        expect(verdictOf('amazon.creative_spec.video_max_length', { durationS: 45 })).toBe('pass')
        expect(verdictOf('amazon.creative_spec.video_max_length', { durationS: 45.1 })).toBe('pass')
        expect(verdictOf('amazon.creative_spec.video_max_length', { durationS: 45.11 })).toBe('fail')
        expect(verdictOf('amazon.creative_spec.video_min_length', { durationS: 6 })).toBe('pass')
        expect(verdictOf('amazon.creative_spec.video_min_length', { durationS: 5.9 })).toBe('pass')
        expect(verdictOf('amazon.creative_spec.video_min_length', { durationS: 5.89 })).toBe('fail')
    })

    it('lets a bumper the encoder made a few frames long pass, and a video a few frames short too', () => {
        const bumper = ruleSet.rules.find((candidate) => candidate.id === 'youtube.creative_spec.bumper_duration')!
        const [check] = evaluateMetadataRules(ruleSet, [bumper], { ...MEDIA, durationS: 6.05 }, [])

        expect(check).toMatchObject({
            verdict: 'pass',
            detail: 'It’s 6.05 seconds long, within the 6 seconds allowed.',
        })
        expect(checkOf('amazon.creative_spec.video_min_length', { durationS: 5.95 })).toMatchObject({
            verdict: 'pass',
            detail: 'It’s 5.95 seconds long, at least the 6 seconds required.',
        })
    })

    it('shows two decimals only when one would read as the limit itself', () => {
        expect(checkOf('amazon.creative_spec.video_max_length', { durationS: 44.96 }).detail).toBe(
            'It’s 44.96 seconds long, within the 45 seconds allowed.',
        )
        expect(checkOf('amazon.creative_spec.video_max_length', { durationS: 45 }).detail).toBe(
            'It’s 45 seconds long, within the 45 seconds allowed.',
        )
        expect(checkOf('amazon.creative_spec.video_max_length', { durationS: 45.14 }).detail).toBe(
            'It’s 45.1 seconds long, longer than the 45 seconds allowed.',
        )
    })

    it('checks the short side against the minimum, and says so when the dimensions are unknown', () => {
        const rule = 'amazon.creative_spec.video_resolution_min'

        expect(verdictOf(rule, { width: 1280, height: 720 })).toBe('pass')
        expect(verdictOf(rule, { width: 1280, height: 719 })).toBe('fail')
        expect(verdictOf(rule, { width: 720, height: 1280 })).toBe('pass')
        // A vertical video is as tall as the limit asks but narrower than it on its short side.
        expect(verdictOf(rule, { width: 405, height: 720 })).toBe('fail')
        expect(verdictOf(rule, { height: undefined })).toBe('unknown')
        expect(verdictOf(rule, { width: undefined })).toBe('unknown')
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
            evaluateMetadataRules(ruleSet, [rule], { ...MEDIA, ...media }, SELECTED)[0]

        it('passes any listed ratio within the tolerance', () => {
            expect(checkWith({ width: 1080, height: 1920 }).verdict).toBe('pass')
            expect(checkWith({ width: 1440, height: 1440 }).verdict).toBe('pass')
            expect(checkWith({ width: 1432, height: 800 }).verdict).toBe('pass')
        })

        it('fails a ratio that is not listed, naming the allowed ones', () => {
            expect(checkWith({ width: 1080, height: 1350 })).toMatchObject({
                verdict: 'fail',
                detail: 'It’s 1080×1350, none of the shapes allowed: 9:16, 1:1, 16:9.',
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
            evaluateMetadataRules(ruleSet, [rule], { ...MEDIA, ...media }, SELECTED)[0]

        it('passes the bounds and anything between them', () => {
            expect(checkWith({ width: 1000, height: 2000 }).verdict).toBe('pass')
            expect(checkWith({ width: 1910, height: 1000 }).verdict).toBe('pass')
            expect(checkWith({ width: 1080, height: 1350 }).verdict).toBe('pass')
        })

        it('fails a ratio outside the range, naming the range', () => {
            expect(checkWith({ width: 900, height: 2000 }).verdict).toBe('fail')
            expect(checkWith({ width: 2000, height: 1000 })).toMatchObject({
                verdict: 'fail',
                detail: 'It’s 2000×1000, outside the shapes allowed: 1:2 to 1.91:1.',
            })
        })

        it('says so when the dimensions are unknown', () => {
            expect(checkWith({ height: undefined }).verdict).toBe('unknown')
        })
    })

    // TikTok in-feed: 540 px on the short side, but 640×640 for a square video.
    describe('a minimum resolution with its own minimum for square videos', () => {
        const checkSquare = (width: number, height: number) => {
            const base = ruleSet.rules.find(
                (candidate) => candidate.id === 'amazon.creative_spec.video_resolution_min',
            )!
            const rule = { ...base, value: 540, params: { squareMin: 640 } }

            return evaluateMetadataRules(ruleSet, [rule], { ...MEDIA, width, height }, SELECTED)[0]
        }

        it('holds a square video to the square minimum', () => {
            expect(checkSquare(600, 600)).toMatchObject({
                verdict: 'fail',
                detail: 'It’s 600×600, a square video, less than the 640 px required for square videos.',
            })
            expect(checkSquare(640, 640)).toMatchObject({
                verdict: 'pass',
                detail: 'It’s 640×640, a square video, at least the 640 px required for square videos.',
            })
        })

        it('holds any other shape to the short-side minimum', () => {
            expect(checkSquare(540, 960).verdict).toBe('pass')
            expect(checkSquare(960, 540).verdict).toBe('pass')
            expect(checkSquare(500, 900).verdict).toBe('fail')
        })
    })

    it('says what was measured against the limit, as a sentence', () => {
        expect(checkOf('amazon.creative_spec.video_max_length', { durationS: 50.04 }).detail).toBe(
            'It’s 50 seconds long, longer than the 45 seconds allowed.',
        )
        expect(checkOf('amazon.creative_spec.video_resolution_min', { width: 1920, height: 1080 }).detail).toBe(
            'It’s 1920×1080, 1080 px on its short side, at least the 720 px required.',
        )
        expect(checkOf('amazon.creative_spec.video_resolution_min', { width: 360, height: 640 }).detail).toBe(
            'It’s 360×640, 360 px on its short side, less than the 720 px required.',
        )
        expect(checkOf('amazon.creative_spec.video_filesize_max', { sizeBytes: 512_340_000 }).detail).toBe(
            'It’s 512.3 MB, more than the 500 MB allowed.',
        )
    })

    it('names the selected placements a placement spec binds, its platforms and its rule', () => {
        const bumper = ruleSet.rules.find((candidate) => candidate.id === 'youtube.creative_spec.bumper_duration')!
        const [check] = evaluateMetadataRules(ruleSet, [bumper], { ...MEDIA, durationS: 30.39 }, [
            Placement.YouTubeBumper,
            Placement.YouTubeShorts,
        ])

        expect(check).toMatchObject({
            verdict: 'fail',
            platform: [RulePlatform.YouTube, RulePlatform.Google],
            placements: [Placement.YouTubeBumper],
            check: 'Bumper ads must be at most 6 seconds long.',
            detail: 'It’s 30.4 seconds long, longer than the 6 seconds allowed.',
        })
    })

    it('names only the selected platforms and their placements for a spec that spans several platforms', () => {
        const bumper = ruleSet.rules.find((candidate) => candidate.id === 'youtube.creative_spec.bumper_duration')!
        const crossPlatform: Rule = {
            ...bumper,
            platform: [RulePlatform.Meta, RulePlatform.YouTube],
            placements: [Placement.MetaReels, Placement.YouTubeShorts],
        }
        const forMeta = resolveSettings(settingsFor({ platforms: [Platform.Meta] }))
        const forYouTube = resolveSettings(settingsFor({ platforms: [Platform.YouTube] }))
        const [metaCheck] = evaluateMetadataRules(
            ruleSet,
            [crossPlatform],
            MEDIA,
            forMeta.placements,
            forMeta.platforms,
        )
        const [youTubeCheck] = evaluateMetadataRules(
            ruleSet,
            [crossPlatform],
            MEDIA,
            forYouTube.placements,
            forYouTube.platforms,
        )

        expect(metaCheck).toMatchObject({ platform: [RulePlatform.Meta], placements: [Placement.MetaReels] })
        expect(youTubeCheck).toMatchObject({ platform: [RulePlatform.YouTube], placements: [Placement.YouTubeShorts] })
    })

    it('keeps a cross-platform spec naming every platform it applies to', () => {
        const rule = { ...ruleSet.rules.find((candidate) => candidate.id === 'amazon.creative_spec.video_max_length')! }
        const everywhere: Rule = { ...rule, platform: [RulePlatform.All], placements: undefined }

        expect(evaluateMetadataRules(ruleSet, [everywhere], MEDIA, SELECTED, [Platform.Amazon])[0].platform).toEqual([
            RulePlatform.All,
        ])
    })

    it('names every placement a placement spec binds when no placement was chosen', () => {
        const bumper = ruleSet.rules.find((candidate) => candidate.id === 'youtube.creative_spec.bumper_duration')!

        expect(evaluateMetadataRules(ruleSet, [bumper], MEDIA, [])[0].placements).toEqual(bumper.placements)
    })

    it('names no placement for a spec that binds every placement of its platforms', () => {
        const rule = { ...ruleSet.rules.find((candidate) => candidate.id === 'amazon.creative_spec.video_max_length')! }

        delete rule.placements

        expect(evaluateMetadataRules(ruleSet, [rule], MEDIA, SELECTED)[0]).not.toHaveProperty('placements')
    })

    it('cites the rule, with its source resolved to a link', () => {
        expect(checkOf('amazon.creative_spec.video_max_length', {})).toMatchObject({
            id: 'amazon.creative_spec.video_max_length',
            quote: 'Between 6 and 45 seconds (20 secs or less highly recommended)',
            ref: expect.stringMatching(/^https:\/\/advertising\.amazon\.com\/resources\/ad-specs\//),
        })
    })
})

describe('buildFindings', () => {
    const contentRule = ruleSet.rules.find((rule) => rule.modality === 'visual')!

    it('keeps the first verdict on a rule the model answered twice, so the report counts it once', () => {
        const findings = buildFindings(
            ruleSet,
            [contentRule],
            [
                { id: contentRule.id, verdict: 'fail', evidence: 'first' },
                { id: contentRule.id, verdict: 'warning', evidence: 'second' },
            ],
        )

        expect(findings).toHaveLength(1)
        expect(findings[0]).toMatchObject({ id: contentRule.id, verdict: 'fail', evidence: 'first' })
    })

    it('names only the platforms the selected ones reach, like metadata checks', () => {
        const crossPlatform = { ...contentRule, platform: [RulePlatform.Meta, RulePlatform.YouTube] }
        const [finding] = buildFindings(
            ruleSet,
            [crossPlatform],
            [{ id: crossPlatform.id, verdict: 'fail', evidence: 'e' }],
            [Platform.Meta],
        )
        const [advisory] = buildAdvisories(ruleSet, [crossPlatform], [Platform.Meta])

        expect(finding.platform).toEqual([RulePlatform.Meta])
        expect(advisory.platform).toEqual([RulePlatform.Meta])
    })

    it('drops ids the model invented', () => {
        expect(buildFindings(ruleSet, [contentRule], [{ id: 'made.up_rule', verdict: 'fail', evidence: 'e' }])).toEqual(
            [],
        )
    })
})
