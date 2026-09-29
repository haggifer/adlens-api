import { Market, Platform } from 'adlens-shared'
import { buildReviewPrompt, parseReviewOutput, REVIEW_OUTPUT_JSON_SCHEMA } from './review-prompt'

const SETTINGS = { platforms: [], placements: [], markets: [] }

describe('buildReviewPrompt', () => {
    it('asks for the transcript as sentence segments, never verbatim in one piece', () => {
        const prompt = buildReviewPrompt(SETTINGS, [])

        expect(prompt).toContain('one per sentence')
        expect(prompt).not.toContain('verbatim transcript')
    })

    it('tells the model that no platform or market chosen means all of them', () => {
        const prompt = buildReviewPrompt({ platforms: [], placements: [], markets: [] }, [])

        expect(prompt).toContain('Platforms: all (none chosen)')
        expect(prompt).toContain('Markets: all (none chosen)')
        expect(prompt).toContain('Placements: not specified')
    })

    it('lists the chosen platforms and markets', () => {
        const prompt = buildReviewPrompt({ platforms: [Platform.Meta], placements: [], markets: [Market.UK] }, [])

        expect(prompt).toContain(`Platforms: ${Platform.Meta}`)
        expect(prompt).toContain(`Markets: ${Market.UK}`)
    })
})

describe('REVIEW_OUTPUT_JSON_SCHEMA', () => {
    it('asks for the transcript as segments with a whole-second start', () => {
        const { transcript } = (REVIEW_OUTPUT_JSON_SCHEMA as { properties: Record<string, unknown> }).properties

        expect(transcript).toMatchObject({
            type: 'array',
            items: { properties: { startS: { type: 'integer' }, text: { type: 'string' } } },
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
        })

        expect(parseReviewOutput(text).transcript).toBe('Imagine this. With Acorns, you can.')
    })

    it('reads no segments as no speech', () => {
        expect(parseReviewOutput(JSON.stringify({ transcript: [], findings: [] })).transcript).toBe('')
    })

    it('rejects a transcript in the old single-string shape', () => {
        expect(() => parseReviewOutput(JSON.stringify({ transcript: 'Buy now', findings: [] }))).toThrow()
    })
})
