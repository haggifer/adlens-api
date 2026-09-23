import { Module } from '@nestjs/common'
import { RulesetService } from './ruleset.service'

@Module({
    providers: [RulesetService],
    exports: [RulesetService],
})
export class RulesModule {}
