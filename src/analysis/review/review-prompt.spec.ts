import { Market, Placement, Platform } from 'adlens-shared'
import { buildReviewOutputJsonSchema, buildReviewPrompt, parseReviewOutput } from './review-prompt'

const SETTINGS = { platforms: [], placements: [], markets: [] }

describe('buildReviewPrompt', () => {
    it('lists the advisory rules to choose from', () => {
        const advisories = [{ id: 'meta.restricted.crypto', check: 'Crypto needs permission.' }]

        expect(buildReviewPrompt(SETTINGS, [], advisories)).toContain(JSON.stringify(advisories))
    })

    it('lists every platform, placement and market when none is chosen, as if all were', () => {
        const prompt = buildReviewPrompt({ platforms: [], placements: [], markets: [] }, [], [])
        const everything = {
            platforms: Object.values(Platform),
            placements: Object.values(Placement),
            markets: Object.values(Market),
        }

        expect(prompt).toContain(`Platforms: ${everything.platforms.join(', ')}`)
        expect(prompt).toContain(`Placements: ${everything.placements.join(', ')}`)
        expect(prompt).toContain(`Markets: ${everything.markets.join(', ')}`)
        expect(prompt).toBe(buildReviewPrompt(everything, [], []))
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

    // Free decimals ran away (`0.000…`, thousands of digits) until the reply hit the token limit: 5 of 6 runs of
    // gemini-3.8-flash on 2026-09-29.
    it("asks for transcript and finding times in whole seconds, capped at the video's length", () => {
        expect(properties.transcript.items.properties.startS).toEqual(SECOND_OF_A_29_4_S_VIDEO)
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

    it('keeps a finding’s time range, and drops an end that doesn’t come after its start', () => {
        const finding = (startS: number, endS: number) => ({ id: 'r', verdict: 'fail', evidence: 'e', startS, endS })
        const text = JSON.stringify({
            transcript: [],
            findings: [finding(3, 7), finding(5, 5), finding(9, 4)],
            advisories: [],
        })

        expect(parseReviewOutput(text).findings.map((parsed) => parsed.time)).toEqual([
            { startS: 3, endS: 7 },
            { startS: 5 },
            { startS: 9 },
        ])
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
