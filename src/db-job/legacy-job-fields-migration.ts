import type { Connection } from 'mongoose'
import { JOB_COLLECTION } from '../database/job.doc'
import type { Migration } from './migrations'

const HAS_NULL_END = { $eq: [{ $type: '$$finding.time.endS' }, 'null'] }

// A finding's time without the `endS: null` some analyses stored; every reader treats a missing end the same.
const FINDINGS_WITHOUT_NULL_ENDS = {
    $map: {
        input: '$analysis.findings',
        as: 'finding',
        in: {
            $cond: [
                HAS_NULL_END,
                { $mergeObjects: ['$$finding', { time: { startS: '$$finding.time.startS' } }] },
                '$$finding',
            ],
        },
    },
}

// Raw updates on purpose: Mongoose would move `updatedAt`, which the stale-job sweep reads as the last status change.
const removeNullEnds = (connection: Connection) =>
    connection
        .collection(JOB_COLLECTION)
        .updateMany({ 'analysis.findings': { $elemMatch: { 'time.endS': { $type: 'null' } } } }, [
            { $set: { 'analysis.findings': FINDINGS_WITHOUT_NULL_ENDS } },
        ])

// A query for `null` matches a missing field too, so storing the null every newer job has changes no behaviour.
const storeHeldChargesAsNull = (connection: Connection, field: 'chargedRunId' | 'chargedIpRunId') =>
    connection.collection(JOB_COLLECTION).updateMany({ [field]: { $exists: false } }, { $set: { [field]: null } })

// Jobs written before their shapes settled: charge ids missing instead of null (2026-09-23 to 2026-09-26), and
// findings whose time held `endS: null` (2026-09-30 to 2026-10-08).
export const LEGACY_JOB_FIELDS_MIGRATION: Migration = {
    id: '2026-10-19-legacy-job-fields',
    up: async (connection) => {
        await removeNullEnds(connection)
        await storeHeldChargesAsNull(connection, 'chargedRunId')
        await storeHeldChargesAsNull(connection, 'chargedIpRunId')
    },
}
