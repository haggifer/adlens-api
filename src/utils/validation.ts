import { AppError } from '@/lib/errors'

export const requireString = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new AppError(400, `Missing or invalid field: ${field}`, 'invalid_argument')
    }

    return value
}

export const requireBody = (body: unknown): Record<string, unknown> => {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new AppError(400, 'Request body must be a JSON object', 'invalid_argument')
    }

    return body as Record<string, unknown>
}
