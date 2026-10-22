import { JOB_COLLECTION } from '../database/job.doc'
import { RULESET_COLLECTION } from '../database/ruleset.doc'
import { ruleSetSchema } from '../rules/schema'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { TEST_RULESET } from '../testing/test-ruleset'
import { DATES_MIGRATION } from './dates-migration'

const COMPLETED_AT = '2026-10-07T10:00:00.000Z'
const DAY = '2026-09-29'
const UPDATED_AT = new Date('2026-10-08T00:00:00.000Z')

// A ruleset as published before the migration: its calendar days written as text.
const LEGACY_RULESET = {
    ...TEST_RULESET,
    meta: { ...TEST_RULESET.meta, generatedAt: DAY },
    sources: Object.fromEntries(
        Object.entries(TEST_RULESET.sources).map(([key, source]) => [key, { ...source, fetchedAt: DAY }]),
    ),
}

describe('the dates migration', () => {
    let mongo: MemoryMongo

    const jobs = () => mongo.connection.collection(JOB_COLLECTION)
    const rulesets = () => mongo.connection.collection(RULESET_COLLECTION)

    beforeAll(async () => {
        mongo = await startMemoryMongo()
    })

    afterEach(async () => {
        await mongo.connection.dropDatabase()
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it("turns an analysis's completion time into a date and leaves the job's updatedAt alone", async () => {
        const { insertedId } = await jobs().insertOne({
            analysis: { completedAt: COMPLETED_AT },
            updatedAt: UPDATED_AT,
        })
        const pending = await jobs().insertOne({ updatedAt: UPDATED_AT })

        await DATES_MIGRATION.up(mongo.connection)

        expect(await jobs().findOne({ _id: insertedId })).toMatchObject({
            analysis: { completedAt: new Date(COMPLETED_AT) },
            updatedAt: UPDATED_AT,
        })
        expect(await jobs().findOne({ _id: pending.insertedId })).not.toHaveProperty('analysis')
    })

    it("turns a ruleset's calendar days into dates the worker's schema reads", async () => {
        await rulesets().insertOne({ version: LEGACY_RULESET.meta.version, ruleset: LEGACY_RULESET })

        await DATES_MIGRATION.up(mongo.connection)

        const stored = await rulesets().findOne()
        const sources = Object.values((stored?.ruleset as typeof LEGACY_RULESET).sources)

        expect(stored?.ruleset.meta.generatedAt).toEqual(new Date(DAY))
        sources.forEach((source) => expect(source.fetchedAt).toEqual(new Date(DAY)))
        expect(ruleSetSchema.parse(stored?.ruleset)).toEqual(ruleSetSchema.parse(LEGACY_RULESET))
    })

    it('changes nothing when it runs again', async () => {
        await jobs().insertOne({ analysis: { completedAt: COMPLETED_AT } })
        await rulesets().insertOne({ version: LEGACY_RULESET.meta.version, ruleset: LEGACY_RULESET })
        await DATES_MIGRATION.up(mongo.connection)

        const before = [await jobs().find().toArray(), await rulesets().find().toArray()]

        await DATES_MIGRATION.up(mongo.connection)

        expect([await jobs().find().toArray(), await rulesets().find().toArray()]).toEqual(before)
    })
})
