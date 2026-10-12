import { describeUserAgent } from './user-agent'

describe('describeUserAgent', () => {
    it.each([
        [
            'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36',
            'Chrome 154 · Android 10',
        ],
        [
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1',
            'Safari 18 · iOS 18',
        ],
        [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0',
            'Edge 154 · Windows',
        ],
        ['Mozilla/5.0 (Macintosh; Intel Mac OS X 15.1; rv:140.0) Gecko/20100101 Firefox/140.0', 'Firefox 140 · macOS'],
        [
            'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
            'Samsung Internet 28 · Android 14',
        ],
    ])('names the browser and system of %s', (userAgent, expected) => {
        expect(describeUserAgent(userAgent)).toBe(expected)
    })

    it('shows an unrecognised header as it is, cut to a readable length', () => {
        expect(describeUserAgent('curl/8.9.1')).toBe('curl/8.9.1')
        expect(describeUserAgent('x'.repeat(500))).toHaveLength(160)
    })

    it('says nothing without a header', () => {
        expect(describeUserAgent(undefined)).toBeNull()
    })
})
