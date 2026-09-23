import type { Model } from 'mongoose'
import { RULESET_MODEL, type RulesetDoc, RulesetSchema } from '../database/ruleset.doc'
import { loadBundledRuleSet } from '../testing/bundled-ruleset'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { RulesetService } from './ruleset.service'

describe('RulesetService', () => {
    let mongo: MemoryMongo
    let model: Model<RulesetDoc>

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        model = mongo.connection.model<RulesetDoc>(RULESET_MODEL, RulesetSchema)
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it('serves the most recently published version', async () => {
        const ruleset = loadBundledRuleSet()

        await model.create([
            {
                version: '1.0.0',
                ruleset: { ...ruleset, meta: { ...ruleset.meta, version: '1.0.0' } },
                publishedAt: new Date(1),
            },
            { version: '1.1.0', ruleset, publishedAt: new Date(2) },
        ])

        expect((await new RulesetService(model).current()).meta.version).toBe('1.1.0')
    })

    it('fails clearly when nothing is published, and tries again on the next call', async () => {
        await model.deleteMany({})

        const service = new RulesetService(model)

        await expect(service.current()).rejects.toThrow('No ruleset has been published')

        await model.create({ version: '1.1.0', ruleset: loadBundledRuleSet(), publishedAt: new Date() })

        expect((await service.current()).meta.version).toBe('1.1.0')
    })
})
