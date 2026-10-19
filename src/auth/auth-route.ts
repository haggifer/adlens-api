import { HttpStatus } from '@nestjs/common'
import { type ApiError, RequestErrorCode } from 'adlens-shared'
import { toNodeHandler } from 'better-auth/node'
import type { Express } from 'express'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { type AuthInstance, withOutbox } from './auth.instance'

type BodyRequest = IncomingMessage & { body?: unknown }

// Better Auth's request bodies are a few short fields. better-call reads them with no limit of its own: only the
// declared content-length bounds a body, and a chunked one has none at all.
/** @public test/auth-flow.test.mjs reads it from dist/, which knip only follows once the API is built (CI runs knip first). */
export const AUTH_BODY_LIMIT_BYTES = 64 * 1024

const TOO_LARGE: ApiError = {
    statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
    errorCode: RequestErrorCode.ValidationFailed,
    message: 'Request body too large',
}

const isBodyless = (req: IncomingMessage) => req.method === 'GET' || req.method === 'HEAD'

const answerTooLarge = (res: ServerResponse, onSent?: () => void): void => {
    res.writeHead(TOO_LARGE.statusCode, { 'content-type': 'application/json', connection: 'close' })
    res.end(JSON.stringify(TOO_LARGE), onSent)
}

// Reads the body up to the limit before Better Auth sees it. better-call takes an already read request's `body` (a
// string is passed on as is), so Better Auth parses exactly the bytes counted here.
const readLimitedBody = (req: BodyRequest, res: ServerResponse, next: () => void): void => {
    if (isBodyless(req)) {
        next()
        return
    }

    // Answered before reading: Node discards the unread body without keeping it, and the client can read the answer.
    if (Number(req.headers['content-length']) > AUTH_BODY_LIMIT_BYTES) {
        answerTooLarge(res)
        return
    }

    const chunks: Buffer[] = []
    let size = 0

    const handleEnd = () => {
        if (size > 0) {
            req.body = Buffer.concat(chunks).toString('utf8')
        }

        next()
    }

    const handleData = (chunk: Buffer) => {
        size += chunk.length

        if (size > AUTH_BODY_LIMIT_BYTES) {
            // A chunked body may never end, so the connection is cut rather than drained.
            req.off('data', handleData)
            req.off('end', handleEnd)
            answerTooLarge(res, () => req.destroy())
            return
        }

        chunks.push(chunk)
    }

    req.on('data', handleData)
    req.once('end', handleEnd)
}

// Mounted before the JSON body parser, so Better Auth reads the raw request.
export const mountAuthRoute = (server: Express, auth: AuthInstance): void => {
    const handler = toNodeHandler(auth)

    server.all('/api/auth/*splat', readLimitedBody, (req, res) => withOutbox(() => handler(req, res)))
}
