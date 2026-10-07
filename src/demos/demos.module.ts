import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module'
import { StorageModule } from '../storage/storage.module'
import { DemosController } from './demos.controller'
import { DemosService } from './demos.service'

@Module({
    imports: [DatabaseModule, StorageModule],
    controllers: [DemosController],
    providers: [DemosService],
})
export class DemosModule {}
