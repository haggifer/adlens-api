import type { Model } from 'mongoose'
import { RULESET_MODEL, type RulesetDoc, RulesetSchema } from '../database/ruleset.doc'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { TEST_RULESET } from '../testing/test-ruleset'
import { RulesetService } from './ruleset.service'

const BUNDLED = TEST_RULESET

describe('RulesetService', () => {
    let mongo: MemoryMongo
    let model: Model<RulesetDoc>

    // Made-up versions, so no test depends on the fixture's version.
    const publish = (version: string, publishedAt: Date) =>
        model.create({ version, ruleset: { ...BUNDLED, meta: { ...BUNDLED.meta, version } }, publishedAt })

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        model = mongo.connection.model<RulesetDoc>(RULESET_MODEL, RulesetSchema)
    })

    afterEach(async () => {
        await model.deleteMany({})
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it('serves the version published last, whatever order the documents were stored in', async () => {
        await publish('9.0.0-middle', new Date('2026-09-02'))
        await publish('9.0.0-newest', new Date('2026-09-03'))
        await publish('9.0.0-oldest', new Date('2026-09-01'))

        expect((await new RulesetService(model).current()).meta.version).toBe('9.0.0-newest')
    })

    it('keeps serving the version it loaded, so a worker analyzes with the ruleset current when it started', async () => {
        await publish('9.0.0-first', new Date('2026-09-01'))

        const service = new RulesetService(model)

        await service.current()
        await publish('9.0.0-second', new Date('2026-09-02'))

        expect((await service.current()).meta.version).toBe('9.0.0-first')
        expect((await new RulesetService(model).current()).meta.version).toBe('9.0.0-second')
    })

    it('fails clearly when nothing is published, and tries again on the next call', async () => {
        const service = new RulesetService(model)

        await expect(service.current()).rejects.toThrow('No ruleset has been published')

        await publish('9.0.0-late', new Date('2026-09-01'))

        expect((await service.current()).meta.version).toBe('9.0.0-late')
    })
})
