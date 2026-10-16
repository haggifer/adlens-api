import { Module } from '@nestjs/common'
import { LivePublisherModule } from '../live/live-publisher.module'
import { PresetsService } from './presets.service'

// The presets storage alone, for the processes that have no routes or sessions: the daily cleanup deletes an anonymous
// user's presets through AccountDataService, and the controller's session guard needs Better Auth.
@Module({
    imports: [LivePublisherModule],
    providers: [PresetsService],
    exports: [PresetsService],
})
export class PresetsStoreModule {}
