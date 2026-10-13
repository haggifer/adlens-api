import { Module } from '@nestjs/common'
import { PresetsController } from './presets.controller'
import { PresetsStoreModule } from './presets-store.module'

@Module({
    imports: [PresetsStoreModule],
    controllers: [PresetsController],
    exports: [PresetsStoreModule],
})
export class PresetsModule {}
