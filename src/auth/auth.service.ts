import { Inject, Injectable } from '@nestjs/common'
import { fromNodeHeaders } from 'better-auth/node'
import type { IncomingHttpHeaders } from 'node:http'
import { AUTH, type AuthInstance } from './auth.instance'

@Injectable()
export class AuthService {
    constructor(@Inject(AUTH) private readonly auth: AuthInstance) {}

    async getUserId(headers: IncomingHttpHeaders): Promise<string | null> {
        const result = await this.auth.api.getSession({ headers: fromNodeHeaders(headers) })

        return result?.user?.id ?? null
    }
}
