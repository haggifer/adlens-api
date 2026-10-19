import { AUTH_INDEXES } from '../auth/auth-indexes'
import { SAMPLE_MODEL, SampleSchema } from '../database/sample.doc'
import { USER_COLLECTION } from '../database/user.doc'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { syncIndexes } from './index-sync'

const DUPLICATE_EMAIL = 'twice@example.com'
const DUPLICATE_SLUG = 'twice'
const DUPLICATE_KEY = 11000
const EXTRA_INDEX = 'title_1'
const UNIQUE_SLUG_INDEX = Object.entries(SampleSchema.indexes().find(([, options]) => options?.unique)![0])
    .flat()
    .join('_')
const UNIQUE_EMAIL_INDEX = AUTH_INDEXES.find(({ collection, index }) => collection === USER_COLLECTION && index.unique)!
    .index.name

describe('syncIndexes', () => {
    let mongo: MemoryMongo

    const samples = () => mongo.connection.model(SAMPLE_MODEL)
    const sampleIndexNames = async () => (await samples().listIndexes()).map((index) => index.name as string)
    const declaredSampleIndexes = SampleSchema.indexes()

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        mongo.connection.model(SAMPLE_MODEL, SampleSchema.clone().set('autoIndex', false).set('autoCreate', false))
    })

    afterEach(async () => {
        await mongo.connection.dropDatabase()
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it('only reports the missing indexes when not applied', async () => {
        const result = await syncIndexes(mongo.connection, false)

        expect(result.missing).toHaveLength(declaredSampleIndexes.length + AUTH_INDEXES.length)
        expect(result.failed).toEqual([])
        expect(await mongo.connection.listCollections()).toEqual([])
    })

    it('creates every declared index when applied, and finds nothing missing on the next run', async () => {
        await syncIndexes(mongo.connection, true)

        const again = await syncIndexes(mongo.connection, true)
        const userIndexes = await mongo.connection.collection(USER_COLLECTION).indexes()

        expect(await sampleIndexNames()).toHaveLength(declaredSampleIndexes.length + 1)
        expect(userIndexes.map((index) => index.name)).toContain(UNIQUE_EMAIL_INDEX)
        expect(again).toEqual({ missing: [], extra: [], failed: [] })
    })

    it('reports an index declared nowhere and keeps it', async () => {
        await samples().createCollection()
        await samples().collection.createIndex({ title: 1 })

        const result = await syncIndexes(mongo.connection, true)

        expect(result.extra).toEqual([{ collection: samples().collection.collectionName, name: EXTRA_INDEX }])
        expect(await sampleIndexNames()).toContain(EXTRA_INDEX)
    })

    it("reports only the model's index the data breaks, and creates its others", async () => {
        await samples().collection.insertMany([{ slug: DUPLICATE_SLUG }, { slug: DUPLICATE_SLUG }])

        const { failed } = await syncIndexes(mongo.connection, true)

        expect(failed).toEqual([
            {
                collection: samples().collection.collectionName,
                name: UNIQUE_SLUG_INDEX,
                reason: expect.stringContaining(String(DUPLICATE_KEY)),
            },
        ])
        expect(await sampleIndexNames()).toHaveLength(declaredSampleIndexes.length)
    })

    it('reports a Better Auth index the data breaks by its error code only, and creates the others', async () => {
        await mongo.connection
            .collection(USER_COLLECTION)
            .insertMany([{ email: DUPLICATE_EMAIL }, { email: DUPLICATE_EMAIL }])

        const result = await syncIndexes(mongo.connection, true)

        expect(result.failed).toEqual([
            {
                collection: USER_COLLECTION,
                name: UNIQUE_EMAIL_INDEX,
                reason: expect.stringContaining(String(DUPLICATE_KEY)),
            },
        ])
        expect(JSON.stringify(result)).not.toContain(DUPLICATE_EMAIL)
        expect(await sampleIndexNames()).toHaveLength(declaredSampleIndexes.length + 1)
    })
})
