import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AbandonedUploadCleanupService } from './cleanup/abandoned-upload-cleanup.service'
import { AnonymousCleanupService } from './cleanup/anonymous-cleanup.service'
import { CleanupModule } from './cleanup/cleanup.module'
import { createLogger } from './common/cloud-logger'
import { readLogFormat } from './config/log-format'

const EXIT_DONE = 0
const EXIT_FAILED = 1

// Entry point of the daily cleanup Cloud Run Job (adlens-cleanup, started by Cloud Scheduler). Exit 1 marks the
// execution as failed in the console; whatever it couldn't delete is simply tried again the next day.
const run = async (): Promise<number> => {
    const app = await NestFactory.createApplicationContext(CleanupModule, {
        logger: createLogger(readLogFormat(process.env)),
    })

    try {
        const anonymous = await app.get(AnonymousCleanupService).run()
        const uploads = await app.get(AbandonedUploadCleanupService).run()

        return anonymous.failed + uploads.failed > 0 ? EXIT_FAILED : EXIT_DONE
    } finally {
        await app.close()
    }
}

void run()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
        new Logger('Cleanup').error(`cleanup failed: ${err instanceof Error ? (err.stack ?? err.message) : err}`)
        process.exit(EXIT_FAILED)
    })
