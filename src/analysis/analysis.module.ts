import { Module } from '@nestjs/common'

import { StorageModule } from '../storage/storage.module'
import { AnalysisQueue } from './analysis.queue'
import { VerifyService } from './verify.service'

@Module({
    imports: [StorageModule],
    providers: [VerifyService, AnalysisQueue],
    exports: [VerifyService, AnalysisQueue],
})
export class AnalysisModule {}
