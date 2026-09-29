import { Module } from '@nestjs/common'
import { AccountModule } from '../account/account.module'
import { appConfigModule } from '../config/env'
import { DatabaseModule } from '../database/database.module'
import { StorageModule } from '../storage/storage.module'
import { AbandonedUploadCleanupService } from './abandoned-upload-cleanup.service'
import { AnonymousCleanupService } from './anonymous-cleanup.service'

// Composition root of the daily cleanup job (cleanup.ts): the database and storage it deletes from, nothing else.
@Module({
    imports: [appConfigModule, DatabaseModule, StorageModule, AccountModule],
    providers: [AnonymousCleanupService, AbandonedUploadCleanupService],
})
export class CleanupModule {}
