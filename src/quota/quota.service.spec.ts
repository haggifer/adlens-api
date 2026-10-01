import { HttpStatus } from '@nestjs/common'
import { QUOTA_WINDOW_MS, RequestErrorCode } from 'adlens-shared'
import { Types } from 'mongoose'
import { ApiException } from '../common/api-exception'
import { USER_COLLECTION } from '../database/user.doc'
import { configStub } from '../testing/config-stub'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { QuotaService } from './quota.service'

const LIMIT = 3
const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-09-23T10:00:00Z')

describe('QuotaService', () => {
    let mongo: MemoryMongo
    let quota: QuotaService
    let userId: string

    const users = () => mongo.connection.collection(USER_COLLECTION)

    const addUser = async (fields: Record<string, unknown> = {}): Promise<string> => {
        const _id = new Types.ObjectId()

        await users().insertOne({ _id, email: `${_id.toString()}@example.com`, ...fields })

        return _id.toString()
    }

    const storedRuns = async (id: string) => (await users().findOne({ _id: new Types.ObjectId(id) }))?.runs ?? []

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        quota = new QuotaService(mongo.connection, configStub({ QUOTA_LIMIT: LIMIT }))
    })

    beforeEach(async () => {
        userId = await addUser()
    })

    afterEach(async () => {
        await users().deleteMany({})
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it('reports an unused quota', async () => {
        expect(await quota.get(userId, NOW)).toEqual({ used: 0, limit: LIMIT, nextFreeAt: null })
    })

    it('counts a run and says when it stops counting', async () => {
        const runId = await quota.consume(userId, 'job-1', NOW)

        expect(await storedRuns(userId)).toEqual([{ id: runId, startedAt: NOW, jobId: 'job-1' }])
        expect(await quota.get(userId, NOW)).toEqual({
            used: 1,
            limit: LIMIT,
            nextFreeAt: new Date(NOW.getTime() + QUOTA_WINDOW_MS).toISOString(),
        })
    })

    it('rejects runs past the limit with QUOTA_EXCEEDED', async () => {
        for (let i = 0; i < LIMIT; i++) {
            await quota.consume(userId, `job-${i}`, NOW)
        }

        const attempt = quota.consume(userId, 'job-extra', NOW)

        await expect(attempt).rejects.toBeInstanceOf(ApiException)
        await expect(attempt).rejects.toMatchObject({
            status: HttpStatus.TOO_MANY_REQUESTS,
            response: { errorCode: RequestErrorCode.QuotaExceeded },
        })
    })

    it('never overdraws under concurrent runs', async () => {
        const results = await Promise.allSettled(
            Array.from({ length: 6 }, (_, i) => quota.consume(userId, `job-${i}`, NOW)),
        )

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(LIMIT)
        expect((await quota.get(userId, NOW)).used).toBe(LIMIT)
    })

    it('frees each slot a window after its own run, not all at once', async () => {
        for (let day = 0; day < LIMIT; day++) {
            await quota.consume(userId, `job-${day}`, new Date(NOW.getTime() + day * DAY_MS))
        }

        const afterFirstExpires = new Date(NOW.getTime() + QUOTA_WINDOW_MS + 1)

        expect(await quota.get(userId, afterFirstExpires)).toMatchObject({
            used: LIMIT - 1,
            nextFreeAt: new Date(NOW.getTime() + DAY_MS + QUOTA_WINDOW_MS).toISOString(),
        })
        await expect(quota.consume(userId, 'job-next', afterFirstExpires)).resolves.toEqual(expect.any(String))
        await expect(quota.consume(userId, 'job-over', afterFirstExpires)).rejects.toBeInstanceOf(ApiException)
    })

    it('counts a run until exactly one window after it started, in both the charge and the report', async () => {
        for (let i = 0; i < LIMIT; i++) {
            await quota.consume(userId, `job-${i}`, NOW)
        }

        const lastCountedMoment = new Date(NOW.getTime() + QUOTA_WINDOW_MS - 1)
        const windowEnd = new Date(NOW.getTime() + QUOTA_WINDOW_MS)

        expect((await quota.get(userId, lastCountedMoment)).used).toBe(LIMIT)
        await expect(quota.consume(userId, 'job-early', lastCountedMoment)).rejects.toBeInstanceOf(ApiException)
        expect((await quota.get(userId, windowEnd)).used).toBe(0)
        await expect(quota.consume(userId, 'job-on-time', windowEnd)).resolves.toEqual(expect.any(String))
    })

    it('drops runs that no longer count when charging', async () => {
        await quota.consume(userId, 'old', NOW)
        await quota.consume(userId, 'new', new Date(NOW.getTime() + QUOTA_WINDOW_MS + 1))

        expect((await storedRuns(userId)).map((run: { jobId: string }) => run.jobId)).toEqual(['new'])
    })

    it('never caps an admin, but still counts their runs', async () => {
        const adminId = await addUser({ isAdmin: true })

        for (let i = 0; i < LIMIT + 2; i++) {
            await quota.consume(adminId, `job-${i}`, NOW)
        }

        expect(await quota.get(adminId, NOW)).toMatchObject({ used: LIMIT + 2, limit: null })
    })

    it('charges the run under the id the caller recorded for it', async () => {
        expect(await quota.consume(userId, 'job-1', NOW, 'run-1')).toBe('run-1')
        expect(await storedRuns(userId)).toEqual([{ id: 'run-1', startedAt: NOW, jobId: 'job-1' }])
    })

    it('refunds exactly the given run', async () => {
        const kept = await quota.consume(userId, 'job-1', NOW)
        const refunded = await quota.consume(userId, 'job-2', NOW)

        await quota.refund(userId, refunded)
        await quota.refund(userId, 'unknown-run')

        expect((await storedRuns(userId)).map((run: { id: string }) => run.id)).toEqual([kept])
    })

    it("never refunds a run through another user's id", async () => {
        const otherId = await addUser()
        const runId = await quota.consume(userId, 'job-1', NOW)

        await quota.refund(otherId, runId)

        expect((await storedRuns(userId)).map((run: { id: string }) => run.id)).toEqual([runId])
    })

    it('takes the limit from the current config, not from stored data', async () => {
        for (let i = 0; i < LIMIT; i++) {
            await quota.consume(userId, `job-${i}`, NOW)
        }

        const raised = new QuotaService(mongo.connection, configStub({ QUOTA_LIMIT: LIMIT + 1 }))

        await expect(raised.consume(userId, 'job-extra', NOW)).resolves.toEqual(expect.any(String))
        expect(await raised.get(userId, NOW)).toMatchObject({ used: LIMIT + 1, limit: LIMIT + 1 })
    })

    it("moves an anonymous user's runs onto an account once, even when the move is retried", async () => {
        const anonymousId = await addUser({ isAnonymous: true })

        await quota.consume(userId, 'own', NOW)
        await quota.consume(anonymousId, 'anonymous', NOW)
        await quota.transfer(anonymousId, userId)
        await quota.transfer(anonymousId, userId)

        expect((await storedRuns(userId)).map((run: { jobId: string }) => run.jobId).sort()).toEqual([
            'anonymous',
            'own',
        ])
    })
})
