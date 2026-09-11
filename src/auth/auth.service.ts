import { Injectable, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as jwt from 'jsonwebtoken'

// The auth seam. Today it verifies a signed JWT (the documented Passport-JWT fallback); Better Auth
// slots in behind this same interface later without touching guards or controllers.
@Injectable()
export class AuthService {
    private readonly secret: string

    constructor(config: ConfigService) {
        this.secret = config.getOrThrow<string>('JWT_SECRET')
    }

    verify(token: string): string {
        try {
            const payload = jwt.verify(token, this.secret)
            const sub = typeof payload === 'object' ? payload.sub : undefined

            if (!sub || typeof sub !== 'string') {
                throw new Error('missing sub')
            }

            return sub
        } catch {
            throw new UnauthorizedException('Invalid or expired token')
        }
    }

    issueDevToken(userId: string): string {
        return jwt.sign({ sub: userId }, this.secret, { expiresIn: '7d' })
    }
}
