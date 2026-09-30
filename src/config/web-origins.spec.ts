import { allowedWebOrigins } from './web-origins'

describe('allowedWebOrigins', () => {
    it('allows only the configured origin in production', () => {
        expect(allowedWebOrigins('https://www.useadlens.com')).toEqual(['https://www.useadlens.com'])
    })

    // A local dev server that finds its port taken starts on the next free one.
    it('allows a local origin and the next five ports', () => {
        expect(allowedWebOrigins('http://localhost:3000')).toEqual([
            'http://localhost:3000',
            'http://localhost:3001',
            'http://localhost:3002',
            'http://localhost:3003',
            'http://localhost:3004',
            'http://localhost:3005',
        ])
    })

    it('counts from the configured local port', () => {
        expect(allowedWebOrigins('http://localhost:4000')).toContain('http://localhost:4005')
        expect(allowedWebOrigins('http://localhost:4000')).not.toContain('http://localhost:3000')
    })
})
