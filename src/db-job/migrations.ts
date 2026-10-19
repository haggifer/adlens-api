import type { Connection } from 'mongoose'

export interface Migration {
    // Dated, so the list reads in the order the migrations were written: `YYYY-MM-DD-<what>`.
    id: string
    // Must be safe to run again: a job that fails part way runs it again from the start.
    up: (connection: Connection) => Promise<void>
}

interface MigrationDoc {
    _id: string
    appliedAt: Date
}

const MIGRATIONS_COLLECTION = 'migrations'

// Every data change older code can't have made, oldest first. Each ships with the code that reads both shapes and
// runs after that code is live, so no running version ever meets a shape it doesn't know.
export const MIGRATIONS: Migration[] = []

// The migrations not yet recorded as applied, in list order; when applied, each runs, then is recorded.
export const runMigrations = async (
    connection: Connection,
    migrations: Migration[],
    isApplied: boolean,
): Promise<string[]> => {
    const records = connection.collection<MigrationDoc>(MIGRATIONS_COLLECTION)
    const applied = await records.find({}, { projection: { _id: 1 } }).toArray()

    const appliedIds = new Set(applied.map((record) => record._id))
    const pending = migrations.filter((migration) => !appliedIds.has(migration.id))

    if (!isApplied) {
        return pending.map((migration) => migration.id)
    }

    // An upsert, so a second job running at the same time (a CI re-run during setup.sh's) records it without failing.
    for (const migration of pending) {
        await migration.up(connection)
        await records.updateOne({ _id: migration.id }, { $setOnInsert: { appliedAt: new Date() } }, { upsert: true })
    }

    return pending.map((migration) => migration.id)
}
