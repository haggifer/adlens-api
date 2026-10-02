import { readFileSync } from 'node:fs'
import { describeError } from '../common/error-message'

// Startup-time validation of the mounted secrets bundle: fail fast, and never put a secret value in the message.
export const readSecretsFile = (path: string | undefined): Record<string, string> => {
    if (!path) {
        return {}
    }

    let raw: string

    try {
        raw = readFileSync(path, 'utf8')
    } catch (err) {
        const reason = describeError(err)

        throw new Error(`SECRETS_FILE: could not read "${path}": ${reason}`)
    }

    let parsed: unknown

    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new Error(`SECRETS_FILE: "${path}" is not valid JSON`)
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`SECRETS_FILE: "${path}" must contain a JSON object`)
    }

    for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== 'string') {
            throw new Error(`SECRETS_FILE: "${path}" key "${key}" must be a string`)
        }
    }

    return parsed as Record<string, string>
}
