import type { Db } from 'mongodb'
import { RATE_LIMIT_COLLECTION, RATE_LIMIT_MODEL, type RateLimitDoc, RateLimitSchema } from '../database/rate-limit.doc'
import { deriveRateLimitKey, hashBucket } from '../ip-quota/ip-key'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { createRateLimitStorage } from './rate-limit-storage'

const SECRET = 'rate-limit-test-secret'
const RAW_KEY = '203.0.113.7|/sign-in/anonymous'
const OTHER_CLIENT_KEY = '203.0.113.8|/sign-in/anonymous'
const OTHER_PATH_KEY = '203.0.113.7|/sign-in/email'
const RULE = { window: 60, max: 3 }
const START = new Date('2026-09-29T10:00:00Z').getTime()

describe('the rate-limit storage', () => {
    let mongo: MemoryMongo
    let clock: number

    const counters = () => mongo.connection.collection<RateLimitDoc>(RATE_LIMIT_COLLECTION)
    const storage = () => createRateLimitStorage(mongo.connection.db as unknown as Db, SECRET, () => clock)

    const consumeTimes = async (count: number) => {
        const results = []

        for (let i = 0; i < count; i++) {
            results.push(await storage().consume(RAW_KEY, RULE))
        }

        return results
    }

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        await mongo.connection.model(RATE_LIMIT_MODEL, RateLimitSchema).init()
    })

    beforeEach(() => {
        clock = START
    })

    afterEach(async () => {
        await counters().deleteMany({})
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it('allows up to the limit in a window, then refuses until the window ends', async () => {
        const results = await consumeTimes(RULE.max + 1)

        expect(results.map((result) => result.allowed)).toEqual([true, true, true, false])
        expect(results[RULE.max].retryAfter).toBe(RULE.window)

        clock = START + RULE.window * 1000 - 1

        expect(await storage().consume(RAW_KEY, RULE)).toEqual({ allowed: false, retryAfter: 1 })

        clock = START + RULE.window * 1000

        expect(await storage().consume(RAW_KEY, RULE)).toEqual({ allowed: true, retryAfter: null })
    })

    it('counts each client and path on its own', async () => {
        await consumeTimes(RULE.max + 1)

        expect(await storage().consume(OTHER_CLIENT_KEY, RULE)).toEqual({ allowed: true, retryAfter: null })
        expect(await storage().consume(OTHER_PATH_KEY, RULE)).toEqual({ allowed: true, retryAfter: null })
    })

    it("doesn't let concurrent requests overdraw", async () => {
        const results = await Promise.all(Array.from({ length: 6 }, () => storage().consume(RAW_KEY, RULE)))

        expect(results.filter((result) => result.allowed)).toHaveLength(RULE.max)
    })

    it('stores only a keyed hash of the address and path, and expires it when the window ends', async () => {
        await storage().consume(RAW_KEY, RULE)

        const stored = await counters().find().toArray()

        expect(stored).toEqual([
            {
                _id: hashBucket(deriveRateLimitKey(SECRET), RAW_KEY),
                count: 1,
                windowStart: new Date(START),
                expiresAt: new Date(START + RULE.window * 1000),
            },
        ])
        expect(JSON.stringify(stored)).not.toContain('203.0.113')
        expect(JSON.stringify(stored)).not.toContain('/sign-in')
    })

    it('has a TTL index on the expiry', async () => {
        const indexes = await counters().indexes()

        expect(indexes).toContainEqual(expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }))
    })
})
