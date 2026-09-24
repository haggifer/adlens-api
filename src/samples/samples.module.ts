import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module'
import { StorageModule } from '../storage/storage.module'
import { SamplesController } from './samples.controller'
import { SamplesService } from './samples.service'

@Module({
    imports: [DatabaseModule, StorageModule],
    controllers: [SamplesController],
    providers: [SamplesService],
    exports: [SamplesService],
})
export class SamplesModule {}
