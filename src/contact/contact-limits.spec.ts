import type { Db } from 'mongodb'
import { RATE_LIMIT_COLLECTION, RATE_LIMIT_MODEL, type RateLimitDoc, RateLimitSchema } from '../database/rate-limit.doc'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { ContactLimits } from './contact-limits'

const SECRET = 'contact-limits-test-secret'
const START = new Date('2026-10-01T10:00:00Z').getTime()
const HOUR_MS = 60 * 60 * 1000

const network = (index: number) => `network-key-${index}`
const sender = (index: number) => `sender${index}@example.com`

describe('the Contact form limits', () => {
    let mongo: MemoryMongo
    let clock: number

    const limits = () => new ContactLimits(mongo.connection.db as unknown as Db, SECRET, () => clock)

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

    it('allows 3 messages per sender an hour, from any network', async () => {
        const results = []

        for (let index = 0; index < 4; index++) {
            results.push(await limits().allowMessage(network(index), sender(0)))
        }

        expect(results).toEqual([true, true, true, false])
    })

    it('allows 3 messages per network an hour, whoever sends them', async () => {
        const results = []

        for (let index = 0; index < 4; index++) {
            results.push(await limits().allowMessage(network(0), sender(index)))
        }

        expect(results).toEqual([true, true, true, false])
    })

    it('allows 20 messages an hour in total', async () => {
        const results = []

        for (let index = 0; index < 21; index++) {
            results.push(await limits().allowMessage(network(index), sender(index)))
        }

        expect(results.filter(Boolean)).toHaveLength(20)
        expect(results[20]).toBe(false)
    })

    it('allows messages again once the hour has passed', async () => {
        for (let index = 0; index < 3; index++) {
            await limits().allowMessage(network(index), sender(0))
        }

        clock = START + HOUR_MS

        expect(await limits().allowMessage(network(9), sender(0))).toBe(true)
    })

    it('does not count a message a narrower cap refused against the wider ones', async () => {
        for (let index = 0; index < 3; index++) {
            await limits().allowMessage(network(0), sender(index))
        }

        // Refused by the network cap, so neither this sender nor the total counts it.
        for (let attempt = 0; attempt < 30; attempt++) {
            await limits().allowMessage(network(0), sender(9))
        }

        const results = []

        for (let index = 1; index < 4; index++) {
            results.push(await limits().allowMessage(network(index), sender(9)))
        }

        expect(results).toEqual([true, true, true])
    })

    it("doesn't let concurrent messages from one sender exceed the cap", async () => {
        const results = await Promise.all(
            Array.from({ length: 8 }, (_, index) => limits().allowMessage(network(index), sender(0))),
        )

        expect(results.filter(Boolean)).toHaveLength(3)
    })

    it("doesn't let concurrent messages exceed the total", async () => {
        const results = await Promise.all(
            Array.from({ length: 30 }, (_, index) => limits().allowMessage(network(index), sender(index))),
        )

        expect(results.filter(Boolean)).toHaveLength(20)
    })

    it('allows 3 upload drafts per network an hour, apart from its messages', async () => {
        const uploads = []

        for (let attempt = 0; attempt < 4; attempt++) {
            uploads.push(await limits().allowUploads(network(0)))
        }

        expect(uploads).toEqual([true, true, true, false])
        expect(await limits().allowMessage(network(0), sender(0))).toBe(true)
    })

    it('stores neither the sender nor the network key', async () => {
        await limits().allowMessage(network(0), sender(0))
        await limits().allowUploads(network(0))

        const stored = JSON.stringify(
            await mongo.connection.collection<RateLimitDoc>(RATE_LIMIT_COLLECTION).find().toArray(),
        )

        expect(stored).not.toContain('example.com')
        expect(stored).not.toContain('network-key')
    })
})
