import { HttpStatus, Logger } from '@nestjs/common'
import { RequestErrorCode } from 'adlens-shared'
import { ApiException } from '../common/api-exception'
import { describeError } from '../common/error-message'

type Fetch = (...args: Parameters<typeof fetch>) => Promise<Response>

interface SiteverifyResult {
    success?: boolean
    'error-codes'?: string[]
}

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const TIMEOUT_MS = 5000

const toSiteverifyBody = (secret: string, token: string, remoteIp: string | null): URLSearchParams =>
    new URLSearchParams({ secret, response: token, ...(remoteIp ? { remoteip: remoteIp } : {}) })

export const challengeFailed = () =>
    new ApiException(HttpStatus.FORBIDDEN, RequestErrorCode.ChallengeFailed, 'The challenge did not pass')

// Tells people from bots. An abstract class so tests and the e2e suite replace it without reaching Cloudflare.
export abstract class ChallengeVerifier {
    abstract verify(token: string, remoteIp: string | null): Promise<boolean>
}

// Fails closed: without a secret, or when Cloudflare can't be reached, a required check doesn't pass. Tokens are
// single-use, so each is verified once.
export class TurnstileVerifier extends ChallengeVerifier {
    private readonly logger = new Logger(TurnstileVerifier.name)

    constructor(
        private readonly secret: string | undefined,
        private readonly fetchFn: Fetch = fetch,
    ) {
        super()
    }

    async verify(token: string, remoteIp: string | null): Promise<boolean> {
        if (!this.secret) {
            this.logger.warn('TURNSTILE_SECRET_KEY is not set, so a required challenge cannot pass')
            return false
        }

        try {
            const response = await this.postSiteverify(toSiteverifyBody(this.secret, token, remoteIp))

            if (!response.ok) {
                this.logger.error(`siteverify responded ${response.status}`)
                return false
            }

            const result = (await response.json()) as SiteverifyResult

            if (!result.success) {
                this.logger.warn(`challenge rejected: ${(result['error-codes'] ?? []).join(', ')}`)
            }

            return result.success === true
        } catch (err) {
            this.logger.error(`siteverify failed: ${describeError(err)}`)
            return false
        }
    }

    private postSiteverify(body: URLSearchParams): Promise<Response> {
        return this.fetchFn(SITEVERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT_MS) })
    }
}
