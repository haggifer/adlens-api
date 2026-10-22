import type { Connection } from 'mongoose'
import { JOB_COLLECTION } from '../database/job.doc'
import { RULESET_COLLECTION } from '../database/ruleset.doc'
import type { Migration } from './migrations'

// `$toDate` returns a date unchanged, so a document already converted stays as it is.
const SOURCES_WITH_DATES = {
    $arrayToObject: {
        $map: {
            input: { $objectToArray: '$ruleset.sources' },
            as: 'source',
            in: {
                k: '$$source.k',
                v: { $mergeObjects: ['$$source.v', { fetchedAt: { $toDate: '$$source.v.fetchedAt' } }] },
            },
        },
    },
}

// Raw updates on purpose: Mongoose would move `updatedAt`, which the stale-job sweep reads as the last status change.
const convertJobs = (connection: Connection) =>
    connection
        .collection(JOB_COLLECTION)
        .updateMany({ 'analysis.completedAt': { $type: 'string' } }, [
            { $set: { 'analysis.completedAt': { $toDate: '$analysis.completedAt' } } },
        ])

const convertRulesets = (connection: Connection) =>
    connection
        .collection(RULESET_COLLECTION)
        .updateMany({}, [
            { $set: { 'ruleset.meta.generatedAt': { $toDate: '$ruleset.meta.generatedAt' } } },
            { $set: { 'ruleset.sources': SOURCES_WITH_DATES } },
        ])

// Analyses' completion times and rulesets' calendar days, stored as text until 2026-10-19, become dates.
export const DATES_MIGRATION: Migration = {
    id: '2026-10-19-dates',
    up: async (connection) => {
        await convertJobs(connection)
        await convertRulesets(connection)
    },
}
