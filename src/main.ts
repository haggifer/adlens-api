import 'reflect-metadata'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import helmet from 'helmet'
import { warmUpFirstAnalysis } from './api-warm-up'
import { AppModule } from './app.module'
import { mountAuthRoute } from './auth/auth-route'
import { AUTH, type AuthInstance } from './auth/auth.instance'
import { ApiExceptionFilter } from './common/api-exception.filter'
import { createLogger } from './common/cloud-logger'
import type { Env } from './config/env'
import { readLogFormat } from './config/log-format'
import { allowedWebOrigins } from './config/web-origins'

const bootstrap = async () => {
    // bodyParser: false so the Better Auth handler can read the raw request before JSON parsing.
    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
        bodyParser: false,
        logger: createLogger(readLogFormat(process.env)),
    })
    const config = app.get<ConfigService<Env, true>>(ConfigService)
    const auth = app.get<AuthInstance>(AUTH)
    const webOrigins = allowedWebOrigins(config.get('WEB_ORIGIN', { infer: true }))

    app.use(helmet())
    app.enableCors({ origin: webOrigins, credentials: true })
    app.enableShutdownHooks()
    app.useGlobalFilters(new ApiExceptionFilter())
    mountAuthRoute(app.getHttpAdapter().getInstance(), auth)
    app.useBodyParser('json', { limit: '1mb' })

    await warmUpFirstAnalysis(app)
    await app.listen(config.get('PORT', { infer: true }))
}

void bootstrap()
