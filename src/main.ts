import 'reflect-metadata'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import { toNodeHandler } from 'better-auth/node'
import helmet from 'helmet'
import { AppModule } from './app.module'
import { AUTH, type AuthInstance } from './auth/auth.instance'
import { ApiExceptionFilter } from './common/api-exception.filter'
import type { Env } from './config/env'
import { RealtimeIoAdapter } from './realtime/realtime-io.adapter'

const bootstrap = async () => {
    // bodyParser: false so the Better Auth handler can read the raw request before JSON parsing.
    const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false })
    const config = app.get<ConfigService<Env, true>>(ConfigService)
    const auth = app.get<AuthInstance>(AUTH)
    const webOrigin = config.get('WEB_ORIGIN', { infer: true })

    app.use(helmet())
    app.enableCors({ origin: webOrigin, credentials: true })
    app.enableShutdownHooks()
    app.useGlobalFilters(new ApiExceptionFilter())
    app.useWebSocketAdapter(new RealtimeIoAdapter(app, webOrigin))
    app.getHttpAdapter().getInstance().all('/api/auth/*splat', toNodeHandler(auth))
    app.useBodyParser('json', { limit: '1mb' })

    await app.listen(config.get('PORT', { infer: true }))
}

void bootstrap()
