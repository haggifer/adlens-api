import { cp, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

// tsc does not emit .json files, so the bundled ruleset is copied into dist after compilation.
const assets = [['src/rules/rules.json', 'dist/rules/rules.json']]

for (const [from, to] of assets) {
    await mkdir(dirname(to), { recursive: true })
    await cp(from, to)
}
