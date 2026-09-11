import 'reflect-metadata'

import { NestFactory } from '@nestjs/core'

import { WorkerModule } from './worker/worker.module'

// Separate process from the API. Bootstraps only the BullMQ consumer + its dependencies.
const bootstrap = async () => {
    const app = await NestFactory.createApplicationContext(WorkerModule)
    app.enableShutdownHooks()
}

void bootstrap()
