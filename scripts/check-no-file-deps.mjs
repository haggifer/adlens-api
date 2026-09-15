import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// CI guard: fail if package.json declares any `file:` dependency. A local path link (e.g.
// file:../adlens-shared) resolves only on a developer's machine, not in a container or Vercel build,
// so it must never reach a committed package.json.
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }
const offenders = Object.entries(all).filter(([, spec]) => String(spec).startsWith('file:'))

if (offenders.length > 0) {
    console.error(`file: dependencies are not allowed: ${offenders.map(([name]) => name).join(', ')}`)
    process.exit(1)
}
