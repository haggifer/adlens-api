import { Market, Platform } from 'adlens-shared'
import { buildReviewPrompt } from './review-prompt'

describe('buildReviewPrompt', () => {
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
