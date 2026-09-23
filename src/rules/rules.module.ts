import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module'
import { RulesetService } from './ruleset.service'

@Module({
    imports: [DatabaseModule],
    providers: [RulesetService],
    exports: [RulesetService],
})
export class RulesModule {}
