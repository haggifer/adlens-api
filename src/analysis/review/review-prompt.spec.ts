import { Market, Platform } from 'adlens-shared'
import { buildReviewOutputJsonSchema, buildReviewPrompt, parseReviewOutput } from './review-prompt'

const SETTINGS = { platforms: [], placements: [], markets: [] }

describe('buildReviewPrompt', () => {
    it('asks for the transcript as sentence segments, never verbatim in one piece', () => {
        const prompt = buildReviewPrompt(SETTINGS, [], [])

        expect(prompt).toContain('one per sentence')
        expect(prompt).not.toContain('verbatim transcript')
    })

    it("says the rules come most important first, and to report every platform's rule for a breached policy", () => {
        const prompt = buildReviewPrompt(SETTINGS, [], [])

        expect(prompt).toContain('Rules are ordered by importance')
        expect(prompt).toContain('return a finding for every one of those rules')
    })

    // Nadex's "even bitcoin" was a crypto `fail` although Google allows crypto ads with certification.
    it('keeps "fail" for a direct violation and a restricted category or indirect evidence as a warning', () => {
        const prompt = buildReviewPrompt(SETTINGS, [], [])

        expect(prompt).toContain('Verdict "fail" means the video itself directly shows or says what the rule forbids')
        expect(prompt).toContain('use "warning", even for a rule whose severity is blocker')
    })

    it('lists the advisory rules and asks which of them this ad falls under', () => {
        const prompt = buildReviewPrompt(
            SETTINGS,
            [],
            [{ id: 'meta.restricted.crypto', check: 'Crypto needs permission.' }],
        )

        expect(prompt).toContain('[{"id":"meta.restricted.crypto","check":"Crypto needs permission."}]')
        expect(prompt).toContain('Return in "advisories" the ids of those whose subject this ad actually falls under')
    })

    it('asks for whole seconds, and startS 0 for an issue that concerns the whole video', () => {
        const prompt = buildReviewPrompt(SETTINGS, [], [])

        expect(prompt).toContain('in whole seconds')
        expect(prompt).toContain('use startS 0 and omit endS')
    })

    it('tells the model that no platform or market chosen means all of them', () => {
        const prompt = buildReviewPrompt({ platforms: [], placements: [], markets: [] }, [], [])

        expect(prompt).toContain('Platforms: all (none chosen)')
        expect(prompt).toContain('Markets: all (none chosen)')
        expect(prompt).toContain('Placements: not specified')
    })

    it('lists the chosen platforms and markets', () => {
        const prompt = buildReviewPrompt({ platforms: [Platform.Meta], placements: [], markets: [Market.UK] }, [], [])

        expect(prompt).toContain(`Platforms: ${Platform.Meta}`)
        expect(prompt).toContain(`Markets: ${Market.UK}`)
    })
})

interface JsonSchema {
    properties: Record<string, { items: { properties: Record<string, unknown> } }>
}

describe('buildReviewOutputJsonSchema', () => {
    const SECOND_OF_A_29_4_S_VIDEO = { type: 'integer', minimum: 0, maximum: 30 }
    const { properties } = buildReviewOutputJsonSchema(29.4) as unknown as JsonSchema

    it('asks for the transcript as segments with a whole-second start', () => {
        expect(properties.transcript).toMatchObject({
            type: 'array',
            items: { properties: { startS: SECOND_OF_A_29_4_S_VIDEO, text: { type: 'string' } } },
        })
    })

    // Free decimals ran away (`0.000…`, thousands of digits) until the reply hit the token limit: 5 of 6 runs of
    // gemini-3.8-flash on 2026-09-29.
    it('asks for the ids of the advisories the ad falls under', () => {
        expect(properties.advisories).toEqual({ type: 'array', items: { type: 'string' } })
        expect((buildReviewOutputJsonSchema(29.4) as unknown as { required: string[] }).required).toContain(
            'advisories',
        )
    })

    it("asks for finding times in whole seconds, capped at the video's length", () => {
        expect(properties.findings.items.properties).toMatchObject({
            startS: SECOND_OF_A_29_4_S_VIDEO,
            endS: SECOND_OF_A_29_4_S_VIDEO,
        })
    })
})

describe('parseReviewOutput', () => {
    it('joins the transcript segments into one string', () => {
        const text = JSON.stringify({
            transcript: [
                { startS: 0, text: 'Imagine this.' },
                { startS: 8, text: 'With Acorns, you can.' },
            ],
            findings: [],
            advisories: [],
        })

        expect(parseReviewOutput(text).transcript).toBe('Imagine this. With Acorns, you can.')
    })

    it('returns the advisory ids the model picked', () => {
        const text = JSON.stringify({ transcript: [], findings: [], advisories: ['meta.restricted.crypto'] })

        expect(parseReviewOutput(text).advisoryIds).toEqual(['meta.restricted.crypto'])
    })

    it('reads no segments as no speech', () => {
        expect(parseReviewOutput(JSON.stringify({ transcript: [], findings: [], advisories: [] })).transcript).toBe('')
    })

    it('rejects a decimal finding time', () => {
        const text = JSON.stringify({
            transcript: [],
            findings: [{ id: 'r', verdict: 'fail', evidence: 'e', startS: 0.5 }],
        })

        expect(() => parseReviewOutput(text)).toThrow()
    })

    it('rejects a transcript in the old single-string shape', () => {
        expect(() =>
            parseReviewOutput(JSON.stringify({ transcript: 'Buy now', findings: [], advisories: [] })),
        ).toThrow()
    })
})
