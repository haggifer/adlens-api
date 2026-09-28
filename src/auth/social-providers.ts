import type { Env } from '../config/env'

type SocialEnv = Partial<
    Pick<Env, 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET' | 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET'>
>

interface OAuthCredentials {
    clientId: string
    clientSecret: string
}

export interface SocialProviderOptions {
    google?: OAuthCredentials & { prompt: 'select_account' }
    github?: OAuthCredentials
}

// Half a pair (a secret that didn't mount) stops the API from starting rather than silently dropping the provider:
// the web app always offers both buttons.
const readCredentials = (
    env: SocialEnv,
    idKey: keyof SocialEnv,
    secretKey: keyof SocialEnv,
): OAuthCredentials | undefined => {
    const clientId = env[idKey]
    const clientSecret = env[secretKey]

    if (!clientId && !clientSecret) {
        return undefined
    }

    if (!clientId || !clientSecret) {
        throw new Error(`${clientId ? secretKey : idKey} is required when ${clientId ? idKey : secretKey} is set`)
    }

    return { clientId, clientSecret }
}

export const toSocialProviders = (env: SocialEnv): SocialProviderOptions => {
    const google = readCredentials(env, 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET')
    const github = readCredentials(env, 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET')

    return {
        // Google otherwise signs straight into the browser's current account; the picker makes the choice deliberate.
        ...(google && { google: { ...google, prompt: 'select_account' as const } }),
        ...(github && { github }),
    }
}
