import { Types } from 'mongoose'
import { USER_COLLECTION } from '../database/user.doc'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import type { AccountDataService } from '../account/account-data.service'
import { ANONYMOUS_RETENTION_MS, AnonymousCleanupService } from './anonymous-cleanup.service'

const NOW = new Date('2026-10-20T03:00:00Z')
const DAY_MS = 24 * 60 * 60 * 1000

const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS)

const inDays = (days: number) => new Date(NOW.getTime() + days * DAY_MS)

describe('AnonymousCleanupService', () => {
    let mongo: MemoryMongo
    let cleanup: AnonymousCleanupService
    const purge = jest.fn(async (_userId: string) => undefined)

    const users = () => mongo.connection.collection(USER_COLLECTION)
    const sessions = () => mongo.connection.collection('session')
    const accounts = () => mongo.connection.collection('account')

    const insertUser = async (fields: Record<string, unknown>): Promise<Types.ObjectId> => {
        const _id = new Types.ObjectId()

        await users().insertOne({ _id, createdAt: daysAgo(30), ...fields })

        return _id
    }

    const exists = async (_id: Types.ObjectId) => Boolean(await users().findOne({ _id }))

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        cleanup = new AnonymousCleanupService(mongo.connection, { purge } as unknown as AccountDataService)
    })

    beforeEach(async () => {
        purge.mockReset()
        purge.mockResolvedValue(undefined)
        await Promise.all([users().deleteMany({}), sessions().deleteMany({}), accounts().deleteMany({})])
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it('keeps anonymous data for a week', () => {
        expect(ANONYMOUS_RETENTION_MS).toBe(7 * DAY_MS)
    })

    it('deletes an anonymous user last seen more than a week ago, with its data, sessions and accounts', async () => {
        const stale = await insertUser({ isAnonymous: true, lastSeenAt: daysAgo(8) })

        await sessions().insertOne({ userId: stale, token: 'expired', expiresAt: daysAgo(1) })
        await accounts().insertOne({ userId: stale, providerId: 'anonymous' })

        const result = await cleanup.run(NOW)

        expect(result).toEqual({ deleted: 1, failed: 0 })
        expect(purge).toHaveBeenCalledWith(stale.toString())
        expect(await exists(stale)).toBe(false)
        expect(await sessions().countDocuments({ userId: stale })).toBe(0)
        expect(await accounts().countDocuments({ userId: stale })).toBe(0)
    })

    it('keeps an anonymous user seen within the last week', async () => {
        const recent = await insertUser({ isAnonymous: true, lastSeenAt: daysAgo(6) })

        const result = await cleanup.run(NOW)

        expect(result).toEqual({ deleted: 0, failed: 0 })
        expect(purge).not.toHaveBeenCalled()
        expect(await exists(recent)).toBe(true)
    })

    it('goes by the creation date when the user was never marked as seen', async () => {
        const old = await insertUser({ isAnonymous: true, createdAt: daysAgo(8) })
        const fresh = await insertUser({ isAnonymous: true, createdAt: daysAgo(2) })

        await cleanup.run(NOW)

        expect(await exists(old)).toBe(false)
        expect(await exists(fresh)).toBe(true)
    })

    it('keeps an anonymous user whose session is still live, however long ago it was marked as seen', async () => {
        const active = await insertUser({ isAnonymous: true, lastSeenAt: daysAgo(10) })

        await sessions().insertOne({ userId: active, token: 'live', expiresAt: inDays(1) })

        await cleanup.run(NOW)

        expect(purge).not.toHaveBeenCalled()
        expect(await exists(active)).toBe(true)
    })

    it('never deletes an account', async () => {
        const member = await insertUser({ email: 'ann@example.com', lastSeenAt: daysAgo(100) })
        const linked = await insertUser({ email: 'bob@example.com', isAnonymous: false, lastSeenAt: daysAgo(100) })

        await cleanup.run(NOW)

        expect(purge).not.toHaveBeenCalled()
        expect(await exists(member)).toBe(true)
        expect(await exists(linked)).toBe(true)
    })

    it('never deletes an unconfirmed account, however long it was unused', async () => {
        const unconfirmed = await insertUser({
            email: 'carol@example.com',
            isAnonymous: false,
            emailVerified: false,
            createdAt: daysAgo(100),
        })

        await cleanup.run(NOW)

        expect(purge).not.toHaveBeenCalled()
        expect(await exists(unconfirmed)).toBe(true)
    })

    it('keeps a user whose data could not be purged, for the next run, and goes on with the others', async () => {
        const failing = await insertUser({ isAnonymous: true, lastSeenAt: daysAgo(9) })
        const other = await insertUser({ isAnonymous: true, lastSeenAt: daysAgo(9) })

        purge.mockImplementation(async (userId) => {
            if (userId === failing.toString()) {
                throw new Error('storage unavailable')
            }
        })

        const result = await cleanup.run(NOW)

        expect(result).toEqual({ deleted: 1, failed: 1 })
        expect(await exists(failing)).toBe(true)
        expect(await exists(other)).toBe(false)
    })
})
