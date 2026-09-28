import { TurnstileVerifier } from './challenge-verifier'

// Cloudflare's documented always-pass test secret and the token its test site keys produce. The fetch is faked, so
// nothing reaches Cloudflare.
const SECRET = '1x0000000000000000000000000000000AA'
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'

const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const fakeFetch = (response: () => Promise<Response>) =>
    jest.fn(async (..._args: Parameters<typeof fetch>) => response())

describe('TurnstileVerifier', () => {
    it('sends the secret, the token and the visitor address to siteverify, and passes on success', async () => {
        const fetchFn = fakeFetch(async () => respond(200, { success: true }))

        expect(await new TurnstileVerifier(SECRET, fetchFn).verify(TOKEN, '203.0.113.7')).toBe(true)

        const [url, init] = fetchFn.mock.calls[0]

        expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify')
        expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
            secret: SECRET,
            response: TOKEN,
            remoteip: '203.0.113.7',
        })
    })

    it('fails when Cloudflare rejects the token', async () => {
        const fetchFn = fakeFetch(async () => respond(200, { success: false, 'error-codes': ['timeout-or-duplicate'] }))

        expect(await new TurnstileVerifier(SECRET, fetchFn).verify(TOKEN, null)).toBe(false)
    })

    it('fails closed when Cloudflare errors or cannot be reached', async () => {
        const failing = fakeFetch(async () => respond(500, {}))
        const unreachable = fakeFetch(async () => {
            throw new Error('network down')
        })

        expect(await new TurnstileVerifier(SECRET, failing).verify(TOKEN, null)).toBe(false)
        expect(await new TurnstileVerifier(SECRET, unreachable).verify(TOKEN, null)).toBe(false)
    })

    it('never passes without a secret, and then never calls Cloudflare', async () => {
        const fetchFn = fakeFetch(async () => respond(200, { success: true }))

        expect(await new TurnstileVerifier(undefined, fetchFn).verify(TOKEN, null)).toBe(false)
        expect(fetchFn).not.toHaveBeenCalled()
    })
})
