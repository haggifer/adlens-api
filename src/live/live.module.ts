import { Module } from '@nestjs/common'
import { LiveController } from './live.controller'
import { LivePublisherModule } from './live-publisher.module'

@Module({
    imports: [LivePublisherModule],
    controllers: [LiveController],
})
export class LiveModule {}
