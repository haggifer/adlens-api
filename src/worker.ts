import 'reflect-metadata'
import { createServer } from 'node:http'

import { NestFactory } from '@nestjs/core'

import { WorkerModule } from './worker/worker.module'

// Separate process from the API. Bootstraps only the BullMQ consumer + its dependencies. A tiny HTTP
// server satisfies Cloud Run's requirement that a service listen on $PORT; the BullMQ worker runs in
// the background (deploy the worker service with CPU always-on and min-instances 1).
const bootstrap = async () => {
    const app = await NestFactory.createApplicationContext(WorkerModule)
    app.enableShutdownHooks()

    const port = Number(process.env.PORT ?? 8081)
    createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('worker ok')
    }).listen(port)
}

void bootstrap()
