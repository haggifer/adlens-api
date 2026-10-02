import { readFileSync } from 'node:fs'
import { describeError } from '../common/error-message'

const readText = (path: string): string => {
    try {
        return readFileSync(path, 'utf8')
    } catch (err) {
        throw new Error(`SECRETS_FILE: could not read "${path}": ${describeError(err)}`)
    }
}

const parseJson = (path: string, raw: string): unknown => {
    try {
        return JSON.parse(raw)
    } catch {
        throw new Error(`SECRETS_FILE: "${path}" is not valid JSON`)
    }
}

// Startup-time validation of the mounted secrets bundle: fail fast, and never put a secret value in the message.
export const readSecretsFile = (path: string | undefined): Record<string, string> => {
    if (!path) {
        return {}
    }

    const parsed = parseJson(path, readText(path))

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
