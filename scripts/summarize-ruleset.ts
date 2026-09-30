import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ruleSetSchema } from '../src/rules/schema'
import { writeSummary } from './ruleset-records'

// Writes rules_current_summary.md next to a ruleset file without publishing it; publishing writes it too.
// Usage: npm run rules:summary -- path/to/rules.json
const [path] = process.argv.slice(2)

if (!path) {
    console.error('Usage: npm run rules:summary -- path/to/rules.json')
    process.exit(1)
}

const file = resolve(path)
const ruleset = ruleSetSchema.parse(JSON.parse(readFileSync(file, 'utf8')))

console.log(`Wrote ${writeSummary(file, ruleset)} for ruleset ${ruleset.meta.version}`)
