import type { mongo } from 'mongoose'
import { z } from 'zod'
import { zodToMongoose } from '../common/zod-to-mongoose'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { syncValidators, toValidator } from './validators'

const COLLECTION = 'validated'
// A new object each time: an insert adds its _id to the object it is given.
const buildValid = () => ({ name: 'ok', count: 2, at: new Date(), meta: { kind: 'a' } })

const docSchema = z.object({
    name: z.string().min(1),
    count: z.number().int().positive(),
    at: z.date(),
    meta: z.object({ kind: z.literal('a') }),
    note: z.string().nullable().default(null),
})

describe('collection validators', () => {
    let mongo: MemoryMongo

    const documents = () => mongo.connection.collection(COLLECTION)
    const readOptions = async () => {
        const [info] = await mongo.connection.db!.listCollections({ name: COLLECTION }).toArray()

        return (info as mongo.CollectionInfo).options
    }

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        mongo.connection.model('Validated', zodToMongoose(docSchema, { collection: COLLECTION, autoCreate: false }))
    })

    afterEach(async () => {
        await mongo.connection.dropDatabase()
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it('accepts what the Zod schema accepts and refuses wrong types, dates as text and non-integers', async () => {
        const validator = toValidator(docSchema)
        const invalid = [
            { ...buildValid(), at: new Date().toISOString() },
            { ...buildValid(), count: 1.5 },
            { ...buildValid(), meta: { kind: 'b' } },
        ]

        await documents().insertMany([buildValid(), { ...buildValid(), extra: true }, ...invalid])

        expect(await documents().countDocuments(validator)).toBe(2)
    })

    it('only reports when not applied: the outdated validator and the documents it would refuse', async () => {
        await documents().insertMany([buildValid(), { ...buildValid(), name: '' }])

        expect(await syncValidators(mongo.connection, false)).toEqual([
            { collection: COLLECTION, isOutdated: true, invalidCount: 1 },
        ])
        expect(await readOptions()).toEqual({})
    })

    it('sets the validator in warn mode, so an invalid write is still stored, and finds it current on the next run', async () => {
        await syncValidators(mongo.connection, true)
        await documents().insertOne({ ...buildValid(), count: -1 })

        expect(await readOptions()).toMatchObject({
            validator: toValidator(docSchema),
            validationLevel: 'moderate',
            validationAction: 'warn',
        })
        expect(await syncValidators(mongo.connection, true)).toEqual([
            { collection: COLLECTION, isOutdated: false, invalidCount: 1 },
        ])
    })
})
