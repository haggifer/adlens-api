import { Logger } from '@nestjs/common'
import { USER_COLLECTION } from '../database/user.doc'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { AUTH_INDEXES, AuthIndexes, ensureAuthIndexes } from './auth-indexes'

const COLLECTIONS = [...new Set(AUTH_INDEXES.map(({ collection }) => collection))]
const DUPLICATE_EMAIL = 'twice@example.com'
const DUPLICATE_KEY = 11000

describe('the Better Auth indexes', () => {
    let mongo: MemoryMongo

    const indexesOf = (collection: string) => mongo.connection.collection(collection).indexes()

    const insertDuplicateUsers = () =>
        mongo.connection
            .collection(USER_COLLECTION)
            .insertMany([{ email: DUPLICATE_EMAIL }, { email: DUPLICATE_EMAIL }])

    beforeAll(async () => {
        mongo = await startMemoryMongo()
    })

    afterEach(async () => {
        jest.restoreAllMocks()
        await mongo.connection.dropDatabase()
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it('creates every declared index on its collection, and changes nothing when it runs again, as on every start', async () => {
        const firstFailures = await ensureAuthIndexes(mongo.connection)
        const before = await Promise.all(COLLECTIONS.map(indexesOf))

        const failures = await ensureAuthIndexes(mongo.connection)
        const after = await Promise.all(COLLECTIONS.map(indexesOf))
        const created = await Promise.all(AUTH_INDEXES.map(({ collection }) => indexesOf(collection)))
        const names = after.flat().map((index) => index.name)

        expect(firstFailures).toEqual([])
        expect(failures).toEqual([])
        AUTH_INDEXES.forEach(({ index }, i) => expect(created[i]).toContainEqual(expect.objectContaining(index)))
        expect(after).toEqual(before)
        expect(names.sort()).toEqual(
            [...AUTH_INDEXES.map(({ index }) => index.name), ...COLLECTIONS.map(() => '_id_')].sort(),
        )
    })

    it('skips only an index the data breaks, and never reports the offending value', async () => {
        await insertDuplicateUsers()

        const failures = await ensureAuthIndexes(mongo.connection)
        const session = await indexesOf('session')

        expect(failures).toEqual([{ name: 'user_email_uidx', reason: expect.stringContaining(String(DUPLICATE_KEY)) }])
        expect(JSON.stringify(failures)).not.toContain(DUPLICATE_EMAIL)
        expect(session.map((index) => index.name)).toEqual(
            expect.arrayContaining(['session_token_uidx', 'session_userId_idx', 'session_expiresAt_ttl']),
        )
    })

    it('logs an index it could not create, by name and error code only, and lets the API start', async () => {
        const logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

        await insertDuplicateUsers()
        await expect(new AuthIndexes(mongo.connection).onApplicationBootstrap()).resolves.toBeUndefined()

        expect(logError).toHaveBeenCalledTimes(1)
        expect(logError.mock.calls[0][0]).toContain('user_email_uidx')
        expect(logError.mock.calls[0][0]).toContain(String(DUPLICATE_KEY))
        expect(logError.mock.calls[0][0]).not.toContain(DUPLICATE_EMAIL)
    })
})
