import { HttpStatus } from '@nestjs/common'
import { QUOTA_WINDOW_MS, RequestErrorCode } from 'adlens-shared'
import type { Model } from 'mongoose'
import { ApiException } from '../common/api-exception'
import { QUOTA_MODEL, type QuotaDoc, QuotaSchema } from '../database/quota.doc'
import { configStub } from '../testing/config-stub'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { QuotaService } from './quota.service'

const LIMIT = 3

describe('QuotaService', () => {
    let mongo: MemoryMongo
    let model: Model<QuotaDoc>
    let quota: QuotaService

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        model = mongo.connection.model<QuotaDoc>(QUOTA_MODEL, QuotaSchema)
        quota = new QuotaService(model, configStub({ QUOTA_LIMIT: LIMIT }))
    })

    afterEach(async () => {
        await model.deleteMany({})
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it('opens a window on the first run and reports it', async () => {
        const now = new Date('2026-09-23T10:00:00Z')
        const windowStart = await quota.consume('u1', now)

        expect(windowStart).toEqual(now)
        expect(await quota.get('u1', now)).toEqual({ used: 1, limit: LIMIT, windowStart: now.toISOString() })
    })

    it('never caps an unlimited account, but still counts its runs', async () => {
        const now = new Date('2026-09-23T10:00:00Z')

        await model.create({ userId: 'admin', used: 0, limit: LIMIT, windowStart: null, isUnlimited: true })

        for (let i = 0; i < LIMIT + 2; i++) {
            await quota.consume('admin', now)
        }

        expect(await quota.get('admin', now)).toEqual({ used: LIMIT + 2, limit: null, windowStart: now.toISOString() })
    })

    it('rejects runs past the limit with QUOTA_EXCEEDED', async () => {
        for (let i = 0; i < LIMIT; i++) {
            await quota.consume('u1')
        }

        const attempt = quota.consume('u1')

        await expect(attempt).rejects.toBeInstanceOf(ApiException)
        await expect(attempt).rejects.toMatchObject({
            status: HttpStatus.TOO_MANY_REQUESTS,
            response: { errorCode: RequestErrorCode.QuotaExceeded },
        })
    })

    it('never overdraws under concurrent runs', async () => {
        const results = await Promise.allSettled(Array.from({ length: 6 }, () => quota.consume('u1')))

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(LIMIT)
        expect((await quota.get('u1')).used).toBe(LIMIT)
    })

    it('starts a new window with the first run after the old one expires', async () => {
        const start = new Date('2026-09-01T10:00:00Z')

        for (let i = 0; i < LIMIT; i++) {
            await quota.consume('u1', start)
        }

        const later = new Date(start.getTime() + QUOTA_WINDOW_MS + 1)

        expect(await quota.get('u1', later)).toEqual({ used: 0, limit: LIMIT, windowStart: null })
        expect(await quota.consume('u1', later)).toEqual(later)
        expect((await quota.get('u1', later)).used).toBe(1)
    })

    it('refunds only into the window the charge was taken from', async () => {
        const first = await quota.consume('u1', new Date('2026-09-01T10:00:00Z'))

        await quota.refund('u1', first)
        expect((await model.findOne({ userId: 'u1' }).lean())?.used).toBe(0)

        await quota.consume('u1', first)
        await quota.consume('u1', new Date(first.getTime() + QUOTA_WINDOW_MS + 1))
        await quota.refund('u1', first)
        expect((await model.findOne({ userId: 'u1' }).lean())?.used).toBe(1)
    })
})
