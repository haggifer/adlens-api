import { type Analysis, JobStatus, VideoMimeType } from 'adlens-shared'
import { getZodSchema } from '../common/zod-to-mongoose'
import { MODEL_DEFINITIONS } from '../database/database.module'
import { JOB_MODEL } from '../database/job.doc'
import { RULESET_MODEL } from '../database/ruleset.doc'
import { toStoredAnalysis } from '../jobs/job.mapper'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { TEST_RULESET } from '../testing/test-ruleset'
import { syncValidators, toValidator } from './validators'

const ANALYSIS: Analysis = {
    model: 'fake-model',
    promptVersion: 'test',
    rulesetVersion: TEST_RULESET.meta.version,
    transcript: 'Buy now',
    findings: [
        {
            id: TEST_RULESET.rules[0].id,
            platform: TEST_RULESET.rules[0].platform,
            topic: 'topic',
            scope: TEST_RULESET.rules[0].scope,
            severity: TEST_RULESET.rules[0].severity,
            verdict: 'fail',
            evidence: 'evidence',
            time: { startS: 1, endS: 3 },
            quote: 'quote',
            ref: 'ref',
        },
    ],
    metadataChecks: [],
    advisories: [],
    completedAt: new Date().toISOString(),
}

// The job a run leaves behind, as the lifecycle stores it.
const ANALYZED_JOB = {
    userId: 'user-id',
    status: JobStatus.Analyzed,
    settings: { platforms: [], placements: [], markets: [] },
    file: { name: 'ad.mp4', contentType: VideoMimeType.Mp4, size: 1_000, bucket: 'bucket', path: 'uploads/ad.mp4' },
    media: { durationS: 12.5, width: 1080, height: 1920, hasAudio: true, sizeBytes: 1_000, contentType: 'video/mp4' },
    analysis: toStoredAnalysis(ANALYSIS),
    chargedRunId: 'run-id',
    chargedIpRunId: null,
}

describe("every model's validator", () => {
    let mongo: MemoryMongo

    const model = (name: string) => mongo.connection.model(name)

    beforeAll(async () => {
        mongo = await startMemoryMongo()

        const models = MODEL_DEFINITIONS.map(({ name, schema }) => mongo.connection.model(name, schema))

        await Promise.all(models.map((registered) => registered.init()))
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it('is derived from the Zod schema the model was built from', () => {
        expect(MODEL_DEFINITIONS.filter(({ schema }) => !getZodSchema(schema))).toEqual([])
    })

    it('is accepted by MongoDB on a collection that exists, and is current on the next run', async () => {
        await syncValidators(mongo.connection, true)

        const again = await syncValidators(mongo.connection, true)

        expect(again.filter((result) => result.isOutdated)).toEqual([])
    })

    it('passes the documents the code stores', async () => {
        await model(JOB_MODEL).create(ANALYZED_JOB)
        await model(RULESET_MODEL).create({ version: '9.0.0', ruleset: TEST_RULESET, publishedAt: new Date() })

        const invalid = await Promise.all(
            MODEL_DEFINITIONS.map(({ name, schema }) =>
                model(name).countDocuments({ $nor: [toValidator(getZodSchema(schema)!)] }),
            ),
        )

        expect(await model(JOB_MODEL).countDocuments()).toBe(1)
        expect(invalid).toEqual(MODEL_DEFINITIONS.map(() => 0))
    })
})
