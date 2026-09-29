import mongoose from 'mongoose'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RULESET_MODEL, RulesetSchema } from '../src/database/ruleset.doc'
import { ruleSetSchema } from '../src/rules/schema'

const loadEnvFile = (path: string): void => {
    try {
        process.loadEnvFile(path)
    } catch {
        // An absent env file is fine; the variable may be set in the shell.
    }
}

// Publishes a ruleset as a new immutable version, validated with the same schema the worker parses it with. A version
// that already exists is refused, so published rules never change underneath past analyses. The ruleset is authored
// outside this repo, so its path is required.
// Usage: npm run rules:publish -- path/to/rules.json
const run = async (): Promise<void> => {
    const [path] = process.argv.slice(2)

    if (!path) {
        throw new Error('Usage: npm run rules:publish -- path/to/rules.json')
    }

    loadEnvFile('.env.local')
    loadEnvFile('.env')

    const file = resolve(path)
    const ruleset = ruleSetSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    const uri = process.env.MONGODB_URI

    if (!uri) {
        throw new Error('MONGODB_URI is not set')
    }

    await mongoose.connect(uri)

    try {
        const model = mongoose.model(RULESET_MODEL, RulesetSchema)

        await model.init()

        const existing = await model.exists({ version: ruleset.meta.version })

        if (existing) {
            throw new Error(`Ruleset ${ruleset.meta.version} is already published; bump meta.version`)
        }

        await model.create({ version: ruleset.meta.version, ruleset, publishedAt: new Date() })
        console.log(`Published ruleset ${ruleset.meta.version} (${ruleset.rules.length} rules) from ${file}`)
    } finally {
        await mongoose.disconnect()
    }
}

run().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
})
