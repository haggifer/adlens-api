import { Inject, Injectable } from '@nestjs/common'
import { fromNodeHeaders } from 'better-auth/node'
import type { IncomingHttpHeaders } from 'node:http'
import { AUTH, type AuthInstance } from './auth.instance'

@Injectable()
export class AuthService {
    constructor(@Inject(AUTH) private readonly auth: AuthInstance) {}

    // Never refreshes: a refresh sets a new cookie that auth.api drops, so the session would be extended in the
    // database while the browser's cookie expires on schedule. The web's own get-session refreshes it.
    async getUserId(headers: IncomingHttpHeaders): Promise<string | null> {
        const result = await this.auth.api.getSession({
            headers: fromNodeHeaders(headers),
            query: { disableRefresh: true },
        })

        return result?.user?.id ?? null
    }
}
