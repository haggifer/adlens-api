import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module'
import { StorageModule } from '../storage/storage.module'
import { AccountDataService } from './account-data.service'

@Module({
    imports: [DatabaseModule, StorageModule],
    providers: [AccountDataService],
    exports: [AccountDataService],
})
export class AccountModule {}
