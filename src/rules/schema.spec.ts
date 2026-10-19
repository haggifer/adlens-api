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
    it('refuses two rules with one id, which findings are matched back to', () => {
        const duplicated = { ...TEST_RULESET, rules: [...TEST_RULESET.rules, { ...METADATA_RULE, value: 1 }] }
        const result = ruleSetSchema.safeParse(duplicated)

        expect(result.success).toBe(false)
        expect(result.error?.issues.map((issue) => issue.message)).toContain(`duplicate rule id ${METADATA_RULE.id}`)
    })

    describe('calendar days', () => {
        const DAY = '2026-09-29'
        const [SOURCE_KEY, SOURCE] = Object.entries(TEST_RULESET.sources)[0]

        const withDays = (generatedAt: unknown, fetchedAt: unknown) => ({
            ...TEST_RULESET,
            meta: { ...TEST_RULESET.meta, generatedAt },
            sources: { ...TEST_RULESET.sources, [SOURCE_KEY]: { ...SOURCE, fetchedAt } },
        })

        it("reads a ruleset file's days as that day's UTC midnight", () => {
            const parsed = ruleSetSchema.parse(withDays(DAY, DAY))

            expect(parsed.meta.generatedAt).toEqual(new Date(`${DAY}T00:00:00.000Z`))
            expect(parsed.sources[SOURCE_KEY].fetchedAt).toEqual(new Date(`${DAY}T00:00:00.000Z`))
        })

        it('reads a stored ruleset whose days are dates already', () => {
            const day = new Date(DAY)

            expect(ruleSetSchema.parse(withDays(day, day)).meta.generatedAt).toEqual(day)
        })

        it('refuses a day written any other way', () => {
            expect(ruleSetSchema.safeParse(withDays('29.09.2026', DAY)).success).toBe(false)
            expect(ruleSetSchema.safeParse(withDays(DAY, `${DAY}T10:00:00Z`)).success).toBe(false)
            expect(ruleSetSchema.safeParse(withDays(null, DAY)).success).toBe(false)
        })
    })
})
