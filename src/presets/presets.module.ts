import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { getConnectionToken } from '@nestjs/mongoose'
import type { Db } from 'mongodb'
import type { Connection } from 'mongoose'
import type { Env } from '../config/env'
import { DatabaseModule } from '../database/database.module'
import { PresetLimitGuard } from './preset-limit.guard'
import { PresetLimits } from './preset-limits'
import { PresetsController } from './presets.controller'
import { PresetsStoreModule } from './presets-store.module'

const createPresetLimits = (connection: Connection, config: ConfigService<Env, true>): PresetLimits => {
    const secret = config.get('BETTER_AUTH_SECRET', { infer: true })

    if (!secret) {
        throw new Error('BETTER_AUTH_SECRET is required: the preset rate-limit counters are keyed with it')
    }

    return new PresetLimits(connection.db as unknown as Db, secret)
}

@Module({
    imports: [DatabaseModule, PresetsStoreModule],
    controllers: [PresetsController],
    providers: [
        { provide: PresetLimits, inject: [getConnectionToken(), ConfigService], useFactory: createPresetLimits },
        PresetLimitGuard,
    ],
    exports: [PresetsStoreModule],
})
export class PresetsModule {}
