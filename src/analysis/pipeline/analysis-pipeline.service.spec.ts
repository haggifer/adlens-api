import { JobErrorCode, JobStatus, Market, Platform, RulePlatform, VideoMimeType } from 'adlens-shared'
import { type Model, Types } from 'mongoose'
import { IP_QUOTA_COLLECTION, type IpQuotaDoc } from '../../database/ip-quota.doc'
import { JOB_MODEL, type JobDoc, JobSchema, type StoredJob } from '../../database/job.doc'
import { USER_COLLECTION } from '../../database/user.doc'
import { IpQuotaService } from '../../ip-quota/ip-quota.service'
import type { IpCharge } from '../../ip-quota/ip-rules'
import { JobLifecycle } from '../../jobs/job-lifecycle.service'
import { QuotaService } from '../../quota/quota.service'
import { RulesetService } from '../../rules/ruleset.service'
import { TEST_RULESET } from '../../testing/test-ruleset'
import { configStub } from '../../testing/config-stub'
import { type MemoryMongo, startMemoryMongo } from '../../testing/memory-mongo'
import { type VideoReview, VideoReviewer } from '../review/video-reviewer'
import { AnalysisPipeline } from './analysis-pipeline.service'
import { ModelAnswerError, ModelCallRefusedError } from './model-answer-error'
import { RetryableError } from './retryable-error'
import { buildModelCall, usageOf } from '../../testing/model-call'

const USER = new Types.ObjectId().toString()
const CALL = buildModelCall()
const NETWORK: IpCharge = { bucketKey: 'network-key', isAnonymous: false, hasPassedChallenge: false }

const cutOff = () => new ModelAnswerError('The model output was cut off at the token limit', CALL)

const malformed = () => new ModelAnswerError('The model returned malformed output', CALL)

// What the Gemini reviewer throws when Vertex answers 503: retryable, and never billed.
const overloaded = () => new RetryableError('overloaded', { cause: new ModelCallRefusedError('overloaded', 503) })

// Our own client timeout: Vertex may still have generated, and billed, the answer.
const timedOut = () => new RetryableError('This operation was aborted')

// What a crash or a lost database write after Gemini answered looks like to the worker: a retryable failure.
const mongoBlip = () => Object.assign(new Error('connection reset'), { name: 'MongoNetworkError' })

class FakeReviewer extends VideoReviewer {
    next: () => Promise<VideoReview> = async () => ({
        model: 'fake-model',
        promptVersion: 'test',
        transcript: 'Buy now',
        findings: [],
        advisoryIds: [],
        call: CALL,
    })

    review = jest.fn(() => this.next())
}

describe('AnalysisPipeline', () => {
    let mongo: MemoryMongo
    let jobs: Model<JobDoc>
    let lifecycle: JobLifecycle
    let reviewer: FakeReviewer
    let pipeline: AnalysisPipeline
    const ruleSet = TEST_RULESET
    const ruleset = { current: async () => ruleSet } as unknown as RulesetService
    const contentRule = ruleSet.rules.find((r) => r.modality === 'visual' && r.platform.includes(RulePlatform.Meta))!
    const cryptoAdvisory = ruleSet.rules.find((r) => r.id === 'meta.restricted.crypto_written_permission')!
    const musicAdvisory = ruleSet.rules.find((r) => r.id === 'meta.ip.music_licensing')!

    const users = () => mongo.connection.collection(USER_COLLECTION)
    const used = async () => ((await users().findOne({ _id: new Types.ObjectId(USER) }))?.runs ?? []).length
    const networks = () => mongo.connection.collection<IpQuotaDoc>(IP_QUOTA_COLLECTION)
    const usedByNetwork = async () => ((await networks().findOne({ _id: NETWORK.bucketKey }))?.runs ?? []).length

    const queueJob = async (ipCharge: IpCharge | null = null): Promise<string> => {
        const job = await jobs.create({
            userId: USER,
            status: JobStatus.Pending,
            settings: { platforms: [Platform.Meta], placements: [], markets: [Market.EU], objective: 'Conversion' },
            file: { name: 'ad.mp4', contentType: VideoMimeType.Mp4, size: 1000, bucket: 'b', path: 'p' },
            chargedRunId: null,
        })
        const jobId = job._id.toString()

        await lifecycle.claimForVerification(USER, jobId)
        await lifecycle.chargeAndQueue(
            jobId,
            USER,
            {
                durationS: 15,
                width: 1080,
                height: 1920,
                hasAudio: true,
                sizeBytes: 1000,
                contentType: VideoMimeType.Mp4,
            },
            ipCharge,
        )

        return jobId
    }

    const findJob = (jobId: string) => jobs.findById(jobId).lean<StoredJob>()

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        jobs = mongo.connection.model<JobDoc>(JOB_MODEL, JobSchema)
        lifecycle = new JobLifecycle(
            jobs,
            new QuotaService(mongo.connection, configStub({ QUOTA_LIMIT: 3 })),
            new IpQuotaService(
                mongo.connection,
                configStub({ IP_ANON_LIMIT: 3, IP_SOFT_LIMIT: 10, IP_HARD_LIMIT: 30, IP_FAILURE_REFUND_LIMIT: 1 }),
            ),
        )
    })

    beforeEach(async () => {
        reviewer = new FakeReviewer()
        pipeline = new AnalysisPipeline(lifecycle, reviewer, ruleset)
        await users().insertOne({ _id: new Types.ObjectId(USER), email: 'user@example.com' })
    })

    afterEach(async () => {
        jest.restoreAllMocks()
        await Promise.all([jobs.deleteMany({}), users().deleteMany({}), networks().deleteMany({})])
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it('stores the assembled analysis, mapping model findings back to cited rules', async () => {
        const jobId = await queueJob()

        reviewer.next = async () => ({
            model: 'fake-model',
            promptVersion: 'test',
            transcript: 'Buy now',
            findings: [
                { id: contentRule.id, verdict: 'fail', evidence: 'Shown at the start', time: { startS: 1, endS: 3 } },
                { id: 'invented.rule_id', verdict: 'fail', evidence: 'hallucinated' },
            ],
            advisoryIds: [],
            call: CALL,
        })

        expect(await pipeline.run(jobId, { isLast: false })).toBe('analyzed')

        const job = await findJob(jobId)

        expect(job?.status).toBe(JobStatus.Analyzed)
        expect(job?.usage).toEqual(usageOf(CALL))
        expect(job?.analysis?.rulesetVersion).toBe(ruleSet.meta.version)
        expect(job?.analysis?.findings).toEqual([
            expect.objectContaining({ id: contentRule.id, time: { startS: 1, endS: 3 }, quote: contentRule.quote }),
        ])
        expect(await used()).toBe(1)
    })

    it('offers the reviewer the selected advisories to choose from', async () => {
        const jobId = await queueJob()

        await pipeline.run(jobId, { isLast: false })

        expect(reviewer.review).toHaveBeenCalledWith(
            expect.objectContaining({
                advisories: expect.arrayContaining([
                    { id: cryptoAdvisory.id, check: cryptoAdvisory.check },
                    { id: musicAdvisory.id, check: musicAdvisory.check },
                ]),
            }),
        )
    })

    // Every ad used to list every advisory, e.g. an alcohol-targeting reminder on a condom ad.
    it('keeps only the advisories the model found relevant to this ad, ignoring ids it invents', async () => {
        const jobId = await queueJob()
        const review = await reviewer.next()

        reviewer.next = async () => ({ ...review, advisoryIds: [cryptoAdvisory.id, 'invented.advisory'] })

        await pipeline.run(jobId, { isLast: false })

        expect((await findJob(jobId))?.analysis?.advisories.map((advisory) => advisory.id)).toEqual([cryptoAdvisory.id])
    })

    it("gives the reviewer the video's duration, so timestamps can't run past it", async () => {
        const jobId = await queueJob()

        await pipeline.run(jobId, { isLast: false })

        expect(reviewer.review).toHaveBeenCalledWith(expect.objectContaining({ durationS: 15 }))
    })

    it('leaves a transient failure for Cloud Run to retry while attempts remain', async () => {
        const jobId = await queueJob()

        reviewer.next = () => Promise.reject(new RetryableError('provider overloaded'))

        await expect(pipeline.run(jobId, { isLast: false })).rejects.toBeInstanceOf(RetryableError)
        expect((await findJob(jobId))?.status).toBe(JobStatus.Analyzing)
        expect(await used()).toBe(1)
    })

    it('fails the job and refunds on the last attempt', async () => {
        const jobId = await queueJob()

        reviewer.next = () => Promise.reject(new RetryableError('provider overloaded'))

        expect(await pipeline.run(jobId, { isLast: true })).toBe('failed')
        expect(await findJob(jobId)).toMatchObject({ status: JobStatus.Error, errorCode: JobErrorCode.AnalysisFailed })
        expect(await used()).toBe(0)
    })

    it('fails a permanent error immediately instead of retrying it', async () => {
        const jobId = await queueJob()

        reviewer.next = () => Promise.reject(new SyntaxError('Unexpected token in model output'))

        expect(await pipeline.run(jobId, { isLast: false })).toBe('failed')
        expect((await findJob(jobId))?.status).toBe(JobStatus.Error)
        expect(await used()).toBe(0)
    })

    it('fails a cut-off answer at once instead of paying for the same answer again, and refunds it', async () => {
        const jobId = await queueJob(NETWORK)

        reviewer.next = () => Promise.reject(cutOff())

        expect(await pipeline.run(jobId, { isLast: false })).toBe('failed')
        expect(await findJob(jobId)).toMatchObject({ status: JobStatus.Error, usage: usageOf(CALL) })
        expect(await used()).toBe(0)
        expect(await usedByNetwork()).toBe(0)
    })

    it('fails a malformed answer at once instead of paying for another, and refunds it', async () => {
        const jobId = await queueJob(NETWORK)

        reviewer.next = () => Promise.reject(malformed())

        expect(await pipeline.run(jobId, { isLast: false })).toBe('failed')
        expect(reviewer.review).toHaveBeenCalledTimes(1)
        expect(await findJob(jobId)).toMatchObject({ status: JobStatus.Error, usage: usageOf(CALL) })
        expect(await used()).toBe(0)
        expect(await usedByNetwork()).toBe(0)
    })

    it('never calls Gemini again once an attempt may have been billed, and fails the job as answered', async () => {
        const jobId = await queueJob(NETWORK)

        jest.spyOn(lifecycle, 'complete').mockRejectedValueOnce(mongoBlip())

        await expect(pipeline.run(jobId, { isLast: false })).rejects.toThrow('connection reset')
        expect(await pipeline.run(jobId, { isLast: false })).toBe('failed')
        expect(reviewer.review).toHaveBeenCalledTimes(1)
        expect(await findJob(jobId)).toMatchObject({ status: JobStatus.Error, errorCode: JobErrorCode.AnalysisFailed })
        expect((await networks().findOne({ _id: NETWORK.bucketKey }))?.refundedFailures).toHaveLength(1)
    })

    it('calls Gemini again after Vertex answered with an HTTP error status, which is never billed', async () => {
        const jobId = await queueJob()

        reviewer.next = () => Promise.reject(overloaded())
        await expect(pipeline.run(jobId, { isLast: false })).rejects.toBeInstanceOf(RetryableError)
        expect((await findJob(jobId))?.modelCallStartedAt).toBeUndefined()
        reviewer.next = new FakeReviewer().next

        expect(await pipeline.run(jobId, { isLast: false })).toBe('analyzed')
        expect(reviewer.review).toHaveBeenCalledTimes(2)
    })

    it('never calls Gemini again after a call that timed out, which may have been billed, and fails it as answered', async () => {
        const jobId = await queueJob(NETWORK)

        reviewer.next = () => Promise.reject(timedOut())
        await expect(pipeline.run(jobId, { isLast: false })).rejects.toBeInstanceOf(RetryableError)
        expect((await findJob(jobId))?.modelCallStartedAt).toBeInstanceOf(Date)

        expect(await pipeline.run(jobId, { isLast: false })).toBe('failed')
        expect(reviewer.review).toHaveBeenCalledTimes(1)
        expect((await networks().findOne({ _id: NETWORK.bucketKey }))?.refundedFailures).toHaveLength(1)
    })

    it('keeps the mark after an unknown failure of the call', async () => {
        const jobId = await queueJob()

        reviewer.next = () => Promise.reject(new SyntaxError('Unexpected token in model output'))
        await pipeline.run(jobId, { isLast: false })

        expect((await findJob(jobId))?.modelCallStartedAt).toBeInstanceOf(Date)
    })

    it('marks the job before calling Gemini', async () => {
        const jobId = await queueJob()

        reviewer.next = async () => {
            expect((await findJob(jobId))?.modelCallStartedAt).toBeInstanceOf(Date)

            return new FakeReviewer().next()
        }

        expect(await pipeline.run(jobId, { isLast: false })).toBe('analyzed')
    })

    it('keeps a failed answer counted once the network used up its refunded failures', async () => {
        reviewer.next = () => Promise.reject(cutOff())

        await pipeline.run(await queueJob(NETWORK), { isLast: false })
        await pipeline.run(await queueJob(NETWORK), { isLast: false })

        expect(await used()).toBe(1)
        expect(await usedByNetwork()).toBe(1)
    })

    it('still refunds a failure the provider caused, whatever the network used up', async () => {
        reviewer.next = () => Promise.reject(cutOff())
        await pipeline.run(await queueJob(NETWORK), { isLast: false })
        reviewer.next = () => Promise.reject(overloaded())

        expect(await pipeline.run(await queueJob(NETWORK), { isLast: true })).toBe('failed')
        expect(await used()).toBe(0)
        expect(await usedByNetwork()).toBe(0)
    })

    it("doesn't store a result for a job that expired while it was analyzed", async () => {
        const jobId = await queueJob()
        const review = reviewer.next

        reviewer.next = async () => {
            await lifecycle.fail(jobId, JobErrorCode.AnalysisTimedOut, 'expired')

            return review()
        }

        expect(await pipeline.run(jobId, { isLast: false })).toBe('skipped')

        const job = await findJob(jobId)

        expect(job).toMatchObject({ status: JobStatus.Error, errorCode: JobErrorCode.AnalysisTimedOut })
        expect(job).not.toHaveProperty('analysis')
        expect(await used()).toBe(0)
    })

    it('skips a job that is already final', async () => {
        const jobId = await queueJob()

        await pipeline.run(jobId, { isLast: false })

        expect(await pipeline.run(jobId, { isLast: false })).toBe('skipped')
        expect(reviewer.review).toHaveBeenCalledTimes(1)
    })
})
