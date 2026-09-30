import { copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { RuleSet } from '../src/rules/schema'
import { summarizeRuleSet } from '../src/rules/summary'

export const SUMMARY_FILE = 'rules_current_summary.md'

// Refreshes the summary the code is kept in sync with, next to the ruleset file.
export const writeSummary = (file: string, ruleset: RuleSet): string => {
    const summaryPath = join(dirname(file), SUMMARY_FILE)

    writeFileSync(summaryPath, summarizeRuleSet(ruleset, basename(file), new Date().toISOString().slice(0, 10)))

    return summaryPath
}

// Keeps a copy of every published version next to the working file, named after it; an existing copy is kept as is.
export const writeVersionCopy = (file: string, ruleset: RuleSet): string => {
    const copyPath = join(dirname(file), `rules_${ruleset.meta.version}.json`)

    if (!existsSync(copyPath)) {
        copyFileSync(file, copyPath)
    }

    return copyPath
}
