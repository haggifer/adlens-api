import { toSocialProviders } from './social-providers'

describe('toSocialProviders', () => {
    it('enables no provider when nothing is configured', () => {
        expect(toSocialProviders({})).toEqual({})
    })

    it('enables Google with its account picker when both Google values are set', () => {
        expect(toSocialProviders({ GOOGLE_CLIENT_ID: 'google-id', GOOGLE_CLIENT_SECRET: 'google-secret' })).toEqual({
            google: { clientId: 'google-id', clientSecret: 'google-secret', prompt: 'select_account' },
        })
    })

    it('enables GitHub when both GitHub values are set', () => {
        expect(toSocialProviders({ GITHUB_CLIENT_ID: 'github-id', GITHUB_CLIENT_SECRET: 'github-secret' })).toEqual({
            github: { clientId: 'github-id', clientSecret: 'github-secret' },
        })
    })

    it('refuses a provider with only one of its two values', () => {
        expect(() => toSocialProviders({ GOOGLE_CLIENT_ID: 'google-id' })).toThrow('GOOGLE_CLIENT_SECRET')
        expect(() => toSocialProviders({ GITHUB_CLIENT_SECRET: 'github-secret' })).toThrow('GITHUB_CLIENT_ID')
    })
})
