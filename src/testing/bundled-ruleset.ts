import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type RuleSet, ruleSetSchema } from '../rules/schema'

// The authored ruleset in the repo (the source that `npm run rules:publish` publishes), for tests.
export const loadBundledRuleSet = (): RuleSet =>
    ruleSetSchema.parse(JSON.parse(readFileSync(join(__dirname, '..', 'rules', 'rules.json'), 'utf8')))
