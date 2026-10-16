import type { Db } from 'mongodb'
import { RATE_LIMIT_COLLECTION, RATE_LIMIT_MODEL, RateLimitSchema } from '../database/rate-limit.doc'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { ContactLimits, PER_NETWORK, PER_SENDER, TOTAL, UPLOADS_PER_NETWORK } from './contact-limits'

const SECRET = 'contact-limits-test-secret'
const START = new Date('2026-10-01T10:00:00Z').getTime()

const network = (index: number) => `network-key-${index}`
const sender = (index: number) => `sender${index}@example.com`

// What a cap answers to one request more than it allows.
const upToCap = (max: number) => [...Array<boolean>(max).fill(true), false]

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

    it('caps the messages per sender an hour, from any network', async () => {
        const results = []

        for (let index = 0; index <= PER_SENDER.max; index++) {
            results.push(await limits().allowMessage(network(index), sender(0)))
        }

        expect(results).toEqual(upToCap(PER_SENDER.max))
    })

    it('caps the messages per network an hour, whoever sends them', async () => {
        const results = []

        for (let index = 0; index <= PER_NETWORK.max; index++) {
            results.push(await limits().allowMessage(network(0), sender(index)))
        }

        expect(results).toEqual(upToCap(PER_NETWORK.max))
    })

    it('allows messages again once the hour has passed', async () => {
        for (let index = 0; index < PER_SENDER.max; index++) {
            await limits().allowMessage(network(index), sender(0))
        }

        clock = START + PER_SENDER.window * 1000

        expect(await limits().allowMessage(network(PER_SENDER.max), sender(0))).toBe(true)
    })

    it('does not count a message a narrower cap refused against the wider ones', async () => {
        const repeater = sender(PER_NETWORK.max)

        for (let index = 0; index < PER_NETWORK.max; index++) {
            await limits().allowMessage(network(0), sender(index))
        }

        // Refused by the network cap, so neither this sender nor the total counts it.
        for (let attempt = 0; attempt <= TOTAL.max; attempt++) {
            await limits().allowMessage(network(0), repeater)
        }

        const results = []

        for (let index = 1; index <= PER_SENDER.max; index++) {
            results.push(await limits().allowMessage(network(index), repeater))
        }

        expect(results).toEqual(Array<boolean>(PER_SENDER.max).fill(true))
    })

    it("doesn't let concurrent messages exceed the total", async () => {
        const results = await Promise.all(
            Array.from({ length: TOTAL.max + 10 }, (_, index) => limits().allowMessage(network(index), sender(index))),
        )

        expect(results.filter(Boolean)).toHaveLength(TOTAL.max)
    })

    it('caps the upload drafts per network an hour, apart from its messages', async () => {
        const uploads = []

        for (let attempt = 0; attempt <= UPLOADS_PER_NETWORK.max; attempt++) {
            uploads.push(await limits().allowUploads(network(0)))
        }

        expect(uploads).toEqual(upToCap(UPLOADS_PER_NETWORK.max))
        expect(await limits().allowMessage(network(0), sender(0))).toBe(true)
    })
})
