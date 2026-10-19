import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { type Migration, runMigrations } from './migrations'

describe('runMigrations', () => {
    let mongo: MemoryMongo
    let ran: string[]

    const buildMigration = (id: string): Migration => ({
        id,
        up: async () => {
            ran.push(id)
        },
    })

    const FIRST = buildMigration('2026-01-01-first')
    const SECOND = buildMigration('2026-01-02-second')

    beforeAll(async () => {
        mongo = await startMemoryMongo()
    })

    beforeEach(() => {
        ran = []
    })

    afterEach(async () => {
        await mongo.connection.dropDatabase()
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it('only lists the pending migrations when not applied', async () => {
        expect(await runMigrations(mongo.connection, [FIRST, SECOND], false)).toEqual([FIRST.id, SECOND.id])
        expect(ran).toEqual([])
        expect(await runMigrations(mongo.connection, [FIRST, SECOND], false)).toEqual([FIRST.id, SECOND.id])
    })

    it('runs the pending migrations in list order and never runs an applied one again', async () => {
        await runMigrations(mongo.connection, [FIRST], true)

        expect(await runMigrations(mongo.connection, [FIRST, SECOND], true)).toEqual([SECOND.id])
        expect(ran).toEqual([FIRST.id, SECOND.id])
        expect(await runMigrations(mongo.connection, [FIRST, SECOND], true)).toEqual([])
    })

    it('records nothing for a migration that fails, so the next run tries it again', async () => {
        const failing: Migration = { id: '2026-01-03-failing', up: () => Promise.reject(new Error('down')) }

        await expect(runMigrations(mongo.connection, [FIRST, failing, SECOND], true)).rejects.toThrow('down')

        expect(ran).toEqual([FIRST.id])
        expect(await runMigrations(mongo.connection, [FIRST, failing, SECOND], false)).toEqual([failing.id, SECOND.id])
    })
})
