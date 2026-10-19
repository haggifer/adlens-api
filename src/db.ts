import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { getConnectionToken } from '@nestjs/mongoose'
import type { Connection } from 'mongoose'
import { createLogger } from './common/cloud-logger'
import { describeErrorWithStack } from './common/error-message'
import { readLogFormat } from './config/log-format'
import { DbJobModule } from './db-job/db-job.module'
import { type IndexRef, type IndexSyncResult, syncIndexes } from './db-job/index-sync'
import { MIGRATIONS, runMigrations } from './db-job/migrations'
import { syncValidators, type ValidatorResult } from './db-job/validators'

interface DbJobResult {
    migrations: string[]
    indexes: IndexSyncResult
    validators: ValidatorResult[]
}

const EXIT_DONE = 0
const EXIT_FAILED = 1
const APPLY_FLAG = '--apply'

const logger = new Logger('Database')

const toIndexKey = ({ collection, name }: IndexRef) => `${collection}.${name}`

const logIndexes = (indexes: IndexSyncResult, isApplied: boolean) => {
    const failedKeys = new Set(indexes.failed.map(toIndexKey))
    const created = indexes.missing.filter((missing) => !failedKeys.has(toIndexKey(missing)))

    for (const ref of created) {
        logger.log(`index ${toIndexKey(ref)}: ${isApplied ? 'created' : 'missing'}`)
    }

    for (const ref of indexes.extra) {
        logger.warn(`index ${toIndexKey(ref)}: declared nowhere; hide it, watch, then drop it by hand`)
    }

    for (const { reason, ...ref } of indexes.failed) {
        logger.error(`index ${toIndexKey(ref)}: could not be created: ${reason}`)
    }
}

const logValidators = (validators: ValidatorResult[], isApplied: boolean) => {
    for (const { collection, isOutdated, invalidCount } of validators) {
        if (isOutdated) {
            logger.log(`validator ${collection}: ${isApplied ? 'updated' : 'outdated'}`)
        }

        if (invalidCount) {
            logger.warn(`validator ${collection}: ${invalidCount} documents don't match the declared shape`)
        }
    }
}

const logResult = ({ migrations, indexes, validators }: DbJobResult, isApplied: boolean) => {
    const mode = isApplied ? 'applied' : `dry run, nothing changed (${APPLY_FLAG} applies)`
    const invalid = validators.reduce((sum, validator) => sum + validator.invalidCount, 0)

    logger.log(
        `${mode}: ${migrations.length} migrations, ${indexes.missing.length} missing indexes ` +
            `(${indexes.extra.length} extra, ${indexes.failed.length} failed), ${invalid} invalid documents`,
    )

    for (const id of migrations) {
        logger.log(`migration ${id}: ${isApplied ? 'applied' : 'pending'}`)
    }

    logIndexes(indexes, isApplied)
    logValidators(validators, isApplied)
}

const updateDatabase = async (connection: Connection, isApplied: boolean): Promise<DbJobResult> => {
    const migrations = await runMigrations(connection, MIGRATIONS, isApplied)
    const indexes = await syncIndexes(connection, isApplied)
    const validators = await syncValidators(connection, isApplied)

    return { migrations, indexes, validators }
}

// Entry point of the database job (adlens-db), which CI runs after every deploy, once the code that reads both the
// old and the new shapes is live: pending migrations first, then every declared index, then every collection's
// validator. Without --apply it only reports what it would do, so a run from a laptop (where .env.local points at
// production) changes nothing by accident. Exit 1 fails the deploy's last step, which is where a broken migration or
// index shows; documents a validator refuses are only reported.
const run = async (): Promise<number> => {
    const isApplied = process.argv.includes(APPLY_FLAG)
    const app = await NestFactory.createApplicationContext(DbJobModule, {
        logger: createLogger(readLogFormat(process.env)),
    })

    try {
        const result = await updateDatabase(app.get<Connection>(getConnectionToken()), isApplied)

        logResult(result, isApplied)

        return result.indexes.failed.length ? EXIT_FAILED : EXIT_DONE
    } finally {
        await app.close()
    }
}

void run()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
        logger.error(`database job failed: ${describeErrorWithStack(err)}`)
        process.exit(EXIT_FAILED)
    })
