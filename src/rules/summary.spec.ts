import { TEST_RULESET } from '../testing/test-ruleset'
import { summarizeRuleSet } from './summary'

const summary = summarizeRuleSet(TEST_RULESET, 'rules_0.0.0-test.json', '2026-09-30')

const rowOf = (firstCell: string): string | undefined =>
    summary.split('\n').find((line) => line.startsWith(`| ${firstCell} |`))

describe('summarizeRuleSet', () => {
    it('names the version and the file it was made from', () => {
        expect(summary).toContain('# Ruleset summary: adlens-rules 0.0.0-test')
        expect(summary).toContain('`rules_0.0.0-test.json`')
    })

    it('says which app option brings each rule platform, including Google Ads through YouTube', () => {
        expect(rowOf('Google')).toMatch(/\| 4 \| YouTube \|$/)
        expect(rowOf('all')).toMatch(/every platform/)
    })

    it('counts the rules per placement, and lists the offered placements no rule uses', () => {
        expect(rowOf('amazon_sponsored_brands_video')).toMatch(/\| Amazon \| 5 \|$/)
        expect(rowOf('meta_reels')).toMatch(/\| Meta \| 0 \|$/)
        expect(summary).toMatch(/Placements offered with no rule of their own: .*`meta_reels`/)
    })

    it('counts the rules per region against the market options', () => {
        expect(rowOf('UK')).toMatch(/\| 2 \| UK market \|$/)
        expect(rowOf('global')).toMatch(/always/)
    })

    it('lists every check type in use and every source', () => {
        expect(rowOf('aspect_ratio_in')).toMatch(/\| 1 \|$/)
        expect(rowOf('AMAZON')).toContain('https://advertising.amazon.com')
    })
})
