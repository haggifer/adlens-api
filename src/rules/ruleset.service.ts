import { Injectable } from '@nestjs/common'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type RuleSet, ruleSetSchema } from './schema'

// Serves the active ruleset. Today it is the bundled rules.json, validated once at startup.
@Injectable()
export class RulesetService {
    private readonly ruleSet: RuleSet = ruleSetSchema.parse(
        JSON.parse(readFileSync(join(__dirname, 'rules.json'), 'utf8')),
    )

    current(): RuleSet {
        return this.ruleSet
    }
}
