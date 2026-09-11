import 'reflect-metadata'

import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'

import { AppModule } from './app.module'

const bootstrap = async () => {
    const app = await NestFactory.create<NestExpressApplication>(AppModule)
    const config = app.get(ConfigService)

    const extraOrigins = (config.get<string>('ALLOWED_ORIGINS') ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean)

    app.enableCors({ origin: ['http://localhost:3000', ...extraOrigins], credentials: true })
    app.useBodyParser('json', { limit: '1mb' })

    const port = Number(config.get('PORT') ?? 8080)
    await app.listen(port)
}

void bootstrap()
