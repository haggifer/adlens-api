import { JOB_COLLECTION } from '../database/job.doc'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { LEGACY_JOB_FIELDS_MIGRATION } from './legacy-job-fields-migration'

const UPDATED_AT = new Date('2026-10-08T00:00:00.000Z')
const RANGE = { startS: 2, endS: 5 }

const buildFinding = (id: string, time: unknown) => ({ id, verdict: 'fail', time })

describe('the legacy job fields migration', () => {
    let mongo: MemoryMongo

    const jobs = () => mongo.connection.collection(JOB_COLLECTION)

    beforeAll(async () => {
        mongo = await startMemoryMongo()
    })

    afterEach(async () => {
        await mongo.connection.dropDatabase()
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it('removes a null end from a finding and keeps every other finding as it was', async () => {
        const findings = [
            buildFinding('moment', { startS: 3, endS: null }),
            buildFinding('range', RANGE),
            buildFinding('whole', undefined),
        ]
        const { insertedId } = await jobs().insertOne({ analysis: { findings }, updatedAt: UPDATED_AT })

        await LEGACY_JOB_FIELDS_MIGRATION.up(mongo.connection)

        expect(await jobs().findOne({ _id: insertedId })).toMatchObject({
            analysis: {
                findings: [buildFinding('moment', { startS: 3 }), buildFinding('range', RANGE), { id: 'whole' }],
            },
            updatedAt: UPDATED_AT,
        })
    })

    it('stores a missing charge id as null and keeps a held one', async () => {
        const missing = await jobs().insertOne({ updatedAt: UPDATED_AT })
        const held = await jobs().insertOne({ chargedRunId: 'run', chargedIpRunId: 'ip-run' })

        await LEGACY_JOB_FIELDS_MIGRATION.up(mongo.connection)

        expect(await jobs().findOne({ _id: missing.insertedId })).toMatchObject({
            chargedRunId: null,
            chargedIpRunId: null,
            updatedAt: UPDATED_AT,
        })
        expect(await jobs().findOne({ _id: held.insertedId })).toMatchObject({
            chargedRunId: 'run',
            chargedIpRunId: 'ip-run',
        })
    })

    it('changes nothing when it runs again', async () => {
        await jobs().insertOne({ analysis: { findings: [buildFinding('moment', { startS: 3, endS: null })] } })
        await LEGACY_JOB_FIELDS_MIGRATION.up(mongo.connection)

        const before = await jobs().find().toArray()

        await LEGACY_JOB_FIELDS_MIGRATION.up(mongo.connection)

        expect(await jobs().find().toArray()).toEqual(before)
    })
})
