import type { Connection, Model, mongo } from 'mongoose'
import { AUTH_INDEXES, describeIndexFailure, ensureAuthIndexes } from '../auth/auth-indexes'

export interface IndexRef {
    collection: string
    name: string
}

export interface IndexFailure extends IndexRef {
    reason: string
}

export interface IndexSyncResult {
    // Declared but not in the database: created when applied.
    missing: IndexRef[]
    // In the database but declared nowhere: only reported, never dropped.
    extra: IndexRef[]
    failed: IndexFailure[]
}

type IndexToCreate = [keys: mongo.IndexSpecification, options?: mongo.CreateIndexesOptions]

const ID_INDEX = '_id_'
const NAMESPACE_NOT_FOUND = 'NamespaceNotFound'
const AUTH_COLLECTIONS = [...new Set(AUTH_INDEXES.map(({ collection }) => collection))]
const AUTH_INDEX_NAMES = new Set(AUTH_INDEXES.map(({ index }) => index.name))

// MongoDB's own name for an index without one: each key and its direction, joined by underscores.
const toDefaultName = (keys: mongo.IndexSpecification) => Object.entries(keys).flat().join('_')

const mergeResults = (results: IndexSyncResult[]): IndexSyncResult => ({
    missing: results.flatMap((result) => result.missing),
    extra: results.flatMap((result) => result.extra),
    failed: results.flatMap((result) => result.failed),
})

const listIndexNames = async (connection: Connection, collection: string): Promise<string[]> => {
    try {
        const indexes = await connection.collection(collection).indexes()

        return indexes.flatMap((index) => (index.name ? [index.name] : []))
    } catch (err) {
        if ((err as { codeName?: unknown }).codeName === NAMESPACE_NOT_FOUND) {
            return []
        }

        throw err
    }
}

// Each index on its own, so one the data can't satisfy (a duplicate under a unique index) is the only one reported.
const createModelIndexes = async (model: Model<unknown>, toCreate: IndexToCreate[], missing: IndexRef[]) => {
    const results = await Promise.allSettled(
        toCreate.map(([keys, options]) => model.collection.createIndex(keys, options)),
    )

    return results.flatMap((result, i) =>
        result.status === 'rejected' ? [{ ...missing[i], reason: describeIndexFailure(result.reason) }] : [],
    )
}

const syncModelIndexes = async (model: Model<unknown>, isApplied: boolean): Promise<IndexSyncResult> => {
    const collection = model.collection.collectionName
    const diff = await model.diffIndexes({ indexOptionsToCreate: true })
    const toCreate = diff.toCreate as IndexToCreate[]

    const missing = toCreate.map(([keys, options]) => ({ collection, name: options?.name ?? toDefaultName(keys) }))
    const extra = (diff.toDrop as string[]).map((name) => ({ collection, name }))
    const failed = isApplied ? await createModelIndexes(model, toCreate, missing) : []

    return { missing, extra, failed }
}

const findExtraAuthIndexes = (existing: Map<string, string[]>): IndexRef[] =>
    AUTH_COLLECTIONS.flatMap((collection) =>
        (existing.get(collection) ?? [])
            .filter((name) => name !== ID_INDEX && !AUTH_INDEX_NAMES.has(name))
            .map((name) => ({ collection, name })),
    )

const syncAuthIndexes = async (connection: Connection, isApplied: boolean): Promise<IndexSyncResult> => {
    const names = await Promise.all(AUTH_COLLECTIONS.map((collection) => listIndexNames(connection, collection)))
    const existing = new Map(AUTH_COLLECTIONS.map((collection, i) => [collection, names[i]]))

    const missing = AUTH_INDEXES.filter(({ collection, index }) => !existing.get(collection)?.includes(index.name))
    const extra = findExtraAuthIndexes(existing)
    const failed = isApplied ? await ensureAuthIndexes(connection) : []

    return { missing: missing.map(({ collection, index }) => ({ collection, name: index.name })), extra, failed }
}

// Every index the models and AUTH_INDEXES declare, compared with the database's: the missing ones are created when
// applied, the extra ones only reported. Dropping is the maintainer's: an index can still serve queries nobody
// declared it for, so it is hidden, watched, then dropped by hand.
export const syncIndexes = async (connection: Connection, isApplied: boolean): Promise<IndexSyncResult> => {
    const models = Object.values(connection.models) as Model<unknown>[]
    const results = await Promise.all(models.map((model) => syncModelIndexes(model, isApplied)))
    const auth = await syncAuthIndexes(connection, isApplied)

    return mergeResults([...results, auth])
}
