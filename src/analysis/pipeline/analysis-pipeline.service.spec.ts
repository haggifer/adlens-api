import { JobErrorCode, JobStatus, Market, Platform, RulePlatform, VideoMimeType } from 'adlens-shared'
import type { Model } from 'mongoose'
import { JOB_MODEL, type JobDoc, JobSchema, type StoredJob } from '../../database/job.doc'
import { QUOTA_MODEL, type QuotaDoc, QuotaSchema } from '../../database/quota.doc'
import { JobLifecycle } from '../../jobs/job-lifecycle.service'
import { QuotaService } from '../../quota/quota.service'
import { RulesetService } from '../../rules/ruleset.service'
import { loadBundledRuleSet } from '../../testing/bundled-ruleset'
import { configStub } from '../../testing/config-stub'
import { type MemoryMongo, startMemoryMongo } from '../../testing/memory-mongo'
import { type VideoReview, VideoReviewer } from '../review/video-reviewer'
import { AnalysisPipeline } from './analysis-pipeline.service'
import { RetryableError } from './retryable-error'

const USER = 'u1'
const USAGE = { promptTokens: 20000, outputTokens: 800, totalTokens: 20800 }

class FakeReviewer extends VideoReviewer {
    next: () => Promise<VideoReview> = async () => ({
        model: 'fake-model',
        promptVersion: 'test',
        transcript: 'Buy now',
        findings: [],
        usage: USAGE,
    })

    review = jest.fn(() => this.next())
}

describe('AnalysisPipeline', () => {
    let mongo: MemoryMongo
    let jobs: Model<JobDoc>
    let quotas: Model<QuotaDoc>
    let lifecycle: JobLifecycle
    let reviewer: FakeReviewer
    let pipeline: AnalysisPipeline
    const ruleSet = loadBundledRuleSet()
    const ruleset = { current: async () => ruleSet } as unknown as RulesetService
    const contentRule = ruleSet.rules.find((r) => r.modality === 'visual' && r.platform.includes(RulePlatform.Meta))!

    const queueJob = async (): Promise<string> => {
        const job = await jobs.create({
            userId: USER,
            status: JobStatus.Pending,
            settings: { platforms: [Platform.Meta], placements: [], markets: [Market.EU], objective: 'Conversion' },
            file: { name: 'ad.mp4', contentType: VideoMimeType.Mp4, size: 1000, bucket: 'b', path: 'p' },
            chargedWindowStart: null,
        })
        const jobId = job._id.toString()

        await lifecycle.claimForVerification(USER, jobId)
        await lifecycle.chargeAndQueue(jobId, USER, {
            durationS: 15,
            width: 1080,
            height: 1920,
            hasAudio: true,
            sizeBytes: 1000,
            contentType: VideoMimeType.Mp4,
        })

        return jobId
    }

    const findJob = (jobId: string) => jobs.findById(jobId).lean<StoredJob>()
    const used = async () => (await quotas.findOne({ userId: USER }).lean())?.used ?? 0

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        jobs = mongo.connection.model<JobDoc>(JOB_MODEL, JobSchema)
        quotas = mongo.connection.model<QuotaDoc>(QUOTA_MODEL, QuotaSchema)
        lifecycle = new JobLifecycle(jobs, new QuotaService(quotas, configStub({ QUOTA_LIMIT: 3 })))
    })

    beforeEach(() => {
        reviewer = new FakeReviewer()
        pipeline = new AnalysisPipeline(lifecycle, reviewer, ruleset)
    })

    afterEach(async () => {
        await Promise.all([jobs.deleteMany({}), quotas.deleteMany({})])
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
            usage: USAGE,
        })

        expect(await pipeline.run(jobId, { isLast: false })).toBe('analyzed')

        const job = await findJob(jobId)

        expect(job?.status).toBe(JobStatus.Analyzed)
        expect(job?.usage).toEqual(USAGE)
        expect(job?.analysis?.rulesetVersion).toBe(ruleSet.meta.version)
        expect(job?.analysis?.findings).toEqual([
            expect.objectContaining({ id: contentRule.id, time: { startS: 1, endS: 3 }, quote: contentRule.quote }),
        ])
        expect(await used()).toBe(1)
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

    it('skips a job that is already final', async () => {
        const jobId = await queueJob()

        await pipeline.run(jobId, { isLast: false })

        expect(await pipeline.run(jobId, { isLast: false })).toBe('skipped')
        expect(reviewer.review).toHaveBeenCalledTimes(1)
    })
})
