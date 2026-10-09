import { TEST_RULESET } from '../testing/test-ruleset'
import { ruleSchema, ruleSetSchema } from './schema'

const METADATA_RULE = TEST_RULESET.rules.find((rule) => rule.id === 'amazon.creative_spec.video_aspect_ratio')!

const withCheck = (checkType: string, params: Record<string, unknown> | undefined) => ({
    ...METADATA_RULE,
    checkType,
    value: undefined,
    params,
})

describe('ruleSchema', () => {
    it('accepts a list of aspect ratios', () => {
        expect(ruleSchema.safeParse(withCheck('aspect_ratio_one_of', { ratios: ['9:16', '1:1'] })).success).toBe(true)
    })

    it('accepts a range of aspect ratios', () => {
        expect(ruleSchema.safeParse(withCheck('aspect_ratio_between', { min: '1:2', max: '1.91:1' })).success).toBe(
            true,
        )
    })

    it('refuses an aspect-ratio list or range with no ratios, or ratios not written as W:H', () => {
        expect(ruleSchema.safeParse(withCheck('aspect_ratio_one_of', undefined)).success).toBe(false)
        expect(ruleSchema.safeParse(withCheck('aspect_ratio_one_of', { ratios: [] })).success).toBe(false)
        expect(ruleSchema.safeParse(withCheck('aspect_ratio_one_of', { ratios: [0.5625] })).success).toBe(false)
        expect(ruleSchema.safeParse(withCheck('aspect_ratio_between', { min: '1:2' })).success).toBe(false)
    })

    it('refuses a ratio with a zero part', () => {
        expect(ruleSchema.safeParse(withCheck('aspect_ratio_one_of', { ratios: ['1:0'] })).success).toBe(false)
        expect(ruleSchema.safeParse(withCheck('aspect_ratio_one_of', { ratios: ['0:1'] })).success).toBe(false)
        expect(ruleSchema.safeParse(withCheck('aspect_ratio_between', { min: '0.0:1', max: '1:1' })).success).toBe(
            false,
        )
    })

    it('compares the ends of a range as numbers, refusing one that runs backwards', () => {
        expect(ruleSchema.safeParse(withCheck('aspect_ratio_between', { min: '4:5', max: '10:9' })).success).toBe(true)
        expect(ruleSchema.safeParse(withCheck('aspect_ratio_between', { min: '1:1', max: '1:1' })).success).toBe(true)
        expect(ruleSchema.safeParse(withCheck('aspect_ratio_between', { min: '1.91:1', max: '1:2' })).success).toBe(
            false,
        )
    })

    it('accepts a separate minimum for square videos on a minimum resolution, and nothing else in its params', () => {
        const resolution = (params: Record<string, unknown> | undefined) => ({
            ...METADATA_RULE,
            checkType: 'resolution_min',
            value: 540,
            params,
        })

        expect(ruleSchema.safeParse(resolution(undefined)).success).toBe(true)
        expect(ruleSchema.safeParse(resolution({ squareMin: 640 })).success).toBe(true)
        expect(ruleSchema.safeParse(resolution({ squareMinimum: 640 })).success).toBe(false)
        expect(ruleSchema.safeParse(resolution({ squareMin: -1 })).success).toBe(false)
    })

    it('still needs a threshold for the other metadata checks', () => {
        expect(ruleSchema.safeParse({ ...METADATA_RULE, value: undefined }).success).toBe(false)
    })
})

describe('ruleSetSchema', () => {
    it('accepts the test ruleset', () => {
        expect(ruleSetSchema.safeParse(TEST_RULESET).success).toBe(true)
    })

    it('refuses two rules with one id, which findings are matched back to', () => {
        const duplicated = { ...TEST_RULESET, rules: [...TEST_RULESET.rules, { ...METADATA_RULE, value: 1 }] }
        const result = ruleSetSchema.safeParse(duplicated)

        expect(result.success).toBe(false)
        expect(result.error?.issues.map((issue) => issue.message)).toContain(`duplicate rule id ${METADATA_RULE.id}`)
    })
})
