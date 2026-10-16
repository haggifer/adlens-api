import type { Db } from 'mongodb'
import { RATE_LIMIT_COLLECTION, RATE_LIMIT_MODEL, RateLimitSchema } from '../database/rate-limit.doc'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { PresetLimits, READS_PER_USER, WRITES_PER_USER } from './preset-limits'

const SECRET = 'preset-limits-test-secret'
const START = new Date('2026-10-14T10:00:00Z').getTime()

describe('the preset limits', () => {
    let mongo: MemoryMongo
    let clock: number

    const limits = () => new PresetLimits(mongo.connection.db as unknown as Db, SECRET, () => clock)

    const allowMany = async (userId: string, isWrite: boolean, count: number): Promise<boolean[]> => {
        const results = []

        for (let index = 0; index < count; index++) {
            results.push(await limits().allow(userId, isWrite))
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
        await mongo.connection.collection(RATE_LIMIT_COLLECTION).deleteMany({})
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it("allows a user's writes up to the cap, then refuses until the window ends", async () => {
        const results = await allowMany('user-1', true, WRITES_PER_USER.max + 1)

        expect(results.filter(Boolean)).toHaveLength(WRITES_PER_USER.max)
        expect(results.at(-1)).toBe(false)

        clock = START + WRITES_PER_USER.window * 1000

        expect(await limits().allow('user-1', true)).toBe(true)
    })

    it('counts reads apart from writes, under their own cap', async () => {
        await allowMany('user-1', true, WRITES_PER_USER.max + 1)

        const reads = await allowMany('user-1', false, READS_PER_USER.max + 1)

        expect(reads.filter(Boolean)).toHaveLength(READS_PER_USER.max)
    })

    it('counts each user apart', async () => {
        await allowMany('user-1', true, WRITES_PER_USER.max + 1)

        expect(await limits().allow('user-2', true)).toBe(true)
    })
})
