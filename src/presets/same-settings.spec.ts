import { type AnalysisSettings, Market, Placement, Platform } from 'adlens-shared'
import { isSameSettings } from './same-settings'

const SETTINGS: AnalysisSettings = {
    platforms: [Platform.Meta, Platform.TikTok],
    placements: [Placement.MetaFeed, Placement.TikTokInFeed],
    markets: [Market.US, Market.EU],
}

const EMPTY: AnalysisSettings = { platforms: [], placements: [], markets: [] }

describe('isSameSettings', () => {
    it('treats the same values in another order as the same settings', () => {
        const reordered: AnalysisSettings = {
            platforms: [Platform.TikTok, Platform.Meta],
            placements: [Placement.TikTokInFeed, Placement.MetaFeed],
            markets: [Market.EU, Market.US],
        }

        expect(isSameSettings(SETTINGS, reordered)).toBe(true)
    })

    it.each([
        ['platforms', { platforms: [Platform.Meta] }],
        ['placements', { placements: [Placement.MetaFeed, Placement.MetaReels] }],
        ['markets', { markets: [Market.US, Market.UK] }],
    ])('tells settings apart when %s differ', (_, change) => {
        expect(isSameSettings(SETTINGS, { ...SETTINGS, ...change })).toBe(false)
        expect(isSameSettings({ ...SETTINGS, ...change }, SETTINGS)).toBe(false)
    })

    it('treats empty settings as equal', () => {
        expect(isSameSettings(EMPTY, { platforms: [], placements: [], markets: [] })).toBe(true)
        expect(isSameSettings(EMPTY, SETTINGS)).toBe(false)
    })
})
