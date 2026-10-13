import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module'
import { PresetsStoreModule } from '../presets/presets-store.module'
import { QuotaModule } from '../quota/quota.module'
import { StorageModule } from '../storage/storage.module'
import { AccountDataService } from './account-data.service'

@Module({
    imports: [DatabaseModule, PresetsStoreModule, QuotaModule, StorageModule],
    providers: [AccountDataService],
    exports: [AccountDataService],
})
export class AccountModule {}
