import 'reflect-metadata'

import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import { toNodeHandler } from 'better-auth/node'

import { AppModule } from './app.module'
import { AUTH, type AuthInstance } from './auth/auth.instance'

const bootstrap = async () => {
    // bodyParser: false so the Better Auth handler can read the raw request before JSON parsing.
    const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false })
    const config = app.get(ConfigService)
    const auth = app.get<AuthInstance>(AUTH)

    const extraOrigins = (config.get<string>('ALLOWED_ORIGINS') ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    const webOrigin = config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000'

    app.enableCors({ origin: [webOrigin, ...extraOrigins], credentials: true, exposedHeaders: ['set-auth-token'] })
    app.getHttpAdapter().getInstance().all('/api/auth/*splat', toNodeHandler(auth))
    app.useBodyParser('json', { limit: '1mb' })

    await app.listen(Number(config.get('PORT') ?? 8080))
}

void bootstrap()
