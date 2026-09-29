import { Logger } from '@nestjs/common'
import { USER_COLLECTION } from '../database/user.doc'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { AUTH_INDEXES, AuthIndexes, ensureAuthIndexes } from './auth-indexes'

const COLLECTIONS = ['session', USER_COLLECTION, 'account', 'verification']
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

    it('creates the indexes behind Better Auth’s lookups, unique where a lookup expects one row', async () => {
        const failures = await ensureAuthIndexes(mongo.connection)
        const [session, user, account, verification] = await Promise.all(COLLECTIONS.map(indexesOf))

        expect(failures).toEqual([])
        expect(session).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'session_token_uidx', key: { token: 1 }, unique: true }),
                expect.objectContaining({ name: 'session_userId_idx', key: { userId: 1 } }),
            ]),
        )
        expect(user).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'user_email_uidx', key: { email: 1 }, unique: true }),
            ]),
        )
        expect(account).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'account_userId_idx', key: { userId: 1 } }),
                expect.objectContaining({
                    name: 'account_providerId_accountId_idx',
                    key: { providerId: 1, accountId: 1 },
                }),
            ]),
        )
        expect(verification).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'verification_identifier_idx', key: { identifier: 1 } }),
            ]),
        )
    })

    it('lets MongoDB delete sessions and verifications as soon as they expire', async () => {
        await ensureAuthIndexes(mongo.connection)

        const session = await indexesOf('session')
        const verification = await indexesOf('verification')

        expect(session).toContainEqual(
            expect.objectContaining({ name: 'session_expiresAt_ttl', key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
        )
        expect(verification).toContainEqual(
            expect.objectContaining({
                name: 'verification_expiresAt_ttl',
                key: { expiresAt: 1 },
                expireAfterSeconds: 0,
            }),
        )
    })

    it('changes nothing when it runs again, as it does on every start', async () => {
        await ensureAuthIndexes(mongo.connection)
        const before = await Promise.all(COLLECTIONS.map(indexesOf))

        const failures = await ensureAuthIndexes(mongo.connection)
        const after = await Promise.all(COLLECTIONS.map(indexesOf))
        const names = after.flat().map((index) => index.name)

        expect(failures).toEqual([])
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
