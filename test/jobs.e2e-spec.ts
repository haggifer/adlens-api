import type { INestApplication } from '@nestjs/common'
import { getConnectionToken, getModelToken } from '@nestjs/mongoose'
import { Test } from '@nestjs/testing'
import { JobErrorCode, JobStatus, MAX_DURATION_S, RequestErrorCode, VideoMimeType } from 'adlens-shared'
import { type Connection, type Model, Types } from 'mongoose'
import type { IncomingHttpHeaders } from 'node:http'
import request from 'supertest'
import { AccountDataService } from '../src/account/account-data.service'
import { AnalysisDispatcher } from '../src/analysis/dispatch/analysis-dispatcher'
import { AppModule } from '../src/app.module'
import { AUTH_INDEXES } from '../src/auth/auth-indexes'
import { AUTH } from '../src/auth/auth.instance'
import { AuthService } from '../src/auth/auth.service'
import { ChallengeVerifier } from '../src/challenge/challenge-verifier'
import { ApiExceptionFilter } from '../src/common/api-exception.filter'
import { UserAccess } from '../src/common/user-access'
import { CONTACT_DRAFT_MODEL, type ContactDraftDoc } from '../src/database/contact-draft.doc'
import { DEMO_OWNER, JOB_MODEL, type JobDoc } from '../src/database/job.doc'
import { RATE_LIMIT_COLLECTION } from '../src/database/rate-limit.doc'
import { SAMPLE_MODEL, type SampleDoc } from '../src/database/sample.doc'
import { USER_COLLECTION } from '../src/database/user.doc'
import { ClientNetworkResolver } from '../src/ip-quota/client-network.resolver'
import { IpQuotaService } from '../src/ip-quota/ip-quota.service'
import { JobLifecycle } from '../src/jobs/job-lifecycle.service'
import { MediaProber, type ProbeResult } from '../src/jobs/verification/media-prober'
import { Mailer, type MailMessage } from '../src/mail/mailer'
import { JobEventsService } from '../src/realtime/job-events.service'
import { type ObjectContent, type ObjectInfo, StorageService } from '../src/storage/storage.service'

const OWNER = new Types.ObjectId().toString()
const STRANGER = new Types.ObjectId().toString()
const SAMPLER = new Types.ObjectId().toString()
const DELETER = new Types.ObjectId().toString()
const PAGER = new Types.ObjectId().toString()
const FILE = { name: 'ad.mp4', contentType: VideoMimeType.Mp4, size: 5_000_000 }
const SETTINGS = { platforms: ['Meta'], placements: ['meta_reels'], markets: ['EU'] }

describe('Jobs API (e2e)', () => {
    let app: INestApplication
    // null: the upload hasn't arrived; an Error: storage can't be reached.
    let storedObject: ObjectInfo | null | Error
    let probe: ProbeResult
    // An Error: ffprobe can't reach the video.
    let probeFailure: Error | null
    const dispatch = jest.fn(async () => 'executions/exec-1')
    const deleteObject = jest.fn(async (_path: string) => undefined)
    // The Contact form's uploaded images, by path; an Error: storage can't be reached.
    const contactObjects = new Map<string, ObjectContent | Error>()
    const sendMail = jest.fn(async (_message: MailMessage) => undefined)
    // 'pass' passes; any other token fails. Nothing reaches Cloudflare.
    const verifyChallenge = jest.fn(async (token: string, _remoteIp: string | null) => token === 'pass')

    const as = (userId: string) => ({ 'x-test-user': userId })
    const createJob = async (): Promise<string> => {
        const res = await request(app.getHttpServer())
            .post('/v1/jobs')
            .set(as(OWNER))
            .send({ settings: SETTINGS, file: FILE })
            .expect(201)

        return res.body.job.id
    }

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(AUTH)
            .useValue({})
            .overrideProvider(AuthService)
            .useValue({ getUserId: async (headers: IncomingHttpHeaders) => headers['x-test-user'] ?? null })
            .overrideProvider(StorageService)
            .useValue({
                bucketName: 'test-bucket',
                createUploadTarget: async (_path: string, contentType: string, size: number) => ({
                    url: 'https://storage.googleapis.com/signed-upload',
                    headers: { 'Content-Type': contentType, 'x-goog-content-length-range': `${size},${size}` },
                }),
                createReadUrl: async () => ({
                    url: 'https://storage.googleapis.com/signed-read',
                    expiresAt: new Date(),
                }),
                getObjectInfo: async () => {
                    if (storedObject instanceof Error) {
                        throw storedObject
                    }

                    return storedObject
                },
                delete: deleteObject,
                readObject: async (path: string) => {
                    const object = contactObjects.get(path)

                    if (object instanceof Error) {
                        throw object
                    }

                    return object ?? null
                },
            })
            .overrideProvider(MediaProber)
            .useValue({
                probe: async () => {
                    if (probeFailure) {
                        throw probeFailure
                    }

                    return probe
                },
            })
            .overrideProvider(AnalysisDispatcher)
            .useValue({ dispatch })
            .overrideProvider(Mailer)
            .useValue({ send: sendMail })
            .overrideProvider(ChallengeVerifier)
            .useValue({ verify: verifyChallenge })
            .overrideProvider(JobEventsService)
            .useValue({ onModuleInit: () => undefined, onModuleDestroy: () => undefined })
            .compile()

        app = moduleRef.createNestApplication()
        app.useGlobalFilters(new ApiExceptionFilter())
        // Listening once for the whole suite: given a server that isn't listening, supertest starts it for each request
        // and closes it when that request ends, which resets concurrent requests still connecting.
        await app.listen(0)

        // Quota runs are stored on Better Auth's user documents, so every test user needs one.
        await app
            .get<Connection>(getConnectionToken())
            .collection(USER_COLLECTION)
            .insertMany(
                [OWNER, STRANGER, SAMPLER, DELETER, PAGER].map((id) => ({
                    _id: new Types.ObjectId(id),
                    email: `${id}@example.com`,
                    emailVerified: true,
                })),
            )
    })

    beforeEach(() => {
        storedObject = { sizeBytes: FILE.size, contentType: FILE.contentType }
        probe = { durationS: 20, width: 1080, height: 1920, hasAudio: true }
        probeFailure = null
        dispatch.mockClear()
        deleteObject.mockClear()
        sendMail.mockClear()
        verifyChallenge.mockClear()
    })

    afterAll(async () => {
        await app.close()
    })

    it('requires a session', async () => {
        const res = await request(app.getHttpServer()).get('/v1/jobs').expect(401)

        expect(res.body.errorCode).toBe(RequestErrorCode.Unauthenticated)
    })

    it('indexes Better Auth’s collections when the app starts', async () => {
        const connection = app.get<Connection>(getConnectionToken())

        for (const { collection, index } of AUTH_INDEXES) {
            const indexes = await connection.collection(collection).indexes()

            expect(indexes.map((existing) => existing.name)).toContain(index.name)
        }
    })

    it('rejects bodies outside the contract', async () => {
        const res = await request(app.getHttpServer())
            .post('/v1/jobs')
            .set(as(OWNER))
            .send({ settings: SETTINGS, file: { ...FILE, contentType: 'video/x-matroska' }, userId: 'someone' })
            .expect(400)

        expect(res.body.errorCode).toBe(RequestErrorCode.ValidationFailed)
        expect(res.body.issues.length).toBeGreaterThan(0)
    })

    it('answers a body too large or in an unsupported charset with its own status, in the error shape', async () => {
        const tooLarge = await request(app.getHttpServer())
            .post('/v1/jobs')
            .set(as(OWNER))
            .send({ settings: SETTINGS, file: FILE, padding: 'x'.repeat(2 * 1024 * 1024) })
            .expect(413)
        const unsupported = await request(app.getHttpServer())
            .post('/v1/jobs')
            .set({ ...as(OWNER), 'Content-Type': 'application/json; charset=latin1' })
            .send(JSON.stringify({ settings: SETTINGS, file: FILE }))
            .expect(415)

        expect(tooLarge.body).toMatchObject({ statusCode: 413, errorCode: RequestErrorCode.ValidationFailed })
        expect(unsupported.body).toMatchObject({ statusCode: 415, errorCode: RequestErrorCode.ValidationFailed })
    })

    it('rejects an option chosen twice', async () => {
        const res = await request(app.getHttpServer())
            .post('/v1/jobs')
            .set(as(OWNER))
            .send({ settings: { ...SETTINGS, platforms: ['Meta', 'Meta'] }, file: FILE })
            .expect(400)

        expect(res.body.errorCode).toBe(RequestErrorCode.ValidationFailed)
    })

    it('creates a pending job with a signed upload bound to the declared size', async () => {
        const res = await request(app.getHttpServer())
            .post('/v1/jobs')
            .set(as(OWNER))
            .send({ settings: SETTINGS, file: FILE })
            .expect(201)

        expect(res.body.job).toMatchObject({ status: JobStatus.Pending, file: FILE })
        expect(res.body.job).not.toHaveProperty('userId')
        expect(res.body.upload.headers['x-goog-content-length-range']).toBe(`${FILE.size},${FILE.size}`)
    })

    it("hides other users' jobs", async () => {
        const jobId = await createJob()
        const res = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set(as(STRANGER)).expect(404)

        expect(res.body.errorCode).toBe(RequestErrorCode.NotFound)
    })

    it('verifies, charges and dispatches once, and refuses a second start', async () => {
        const jobId = await createJob()
        const started = await request(app.getHttpServer()).post(`/v1/jobs/${jobId}/analyze`).set(as(OWNER)).expect(202)

        expect(started.body.job).toMatchObject({ status: JobStatus.Queued, media: { durationS: 20 } })
        expect(dispatch).toHaveBeenCalledWith(jobId)

        const again = await request(app.getHttpServer()).post(`/v1/jobs/${jobId}/analyze`).set(as(OWNER)).expect(409)
        const quota = await request(app.getHttpServer()).get('/v1/me/quota').set(as(OWNER)).expect(200)

        expect(again.body.errorCode).toBe(RequestErrorCode.JobNotPending)
        expect(quota.body.quota.used).toBe(1)
    })

    // The web never starts the same job twice: a failed start creates a new job, so this one ends.
    it('answers UPLOAD_INCOMPLETE and ends the job as UPLOAD_FAILED when the upload is missing', async () => {
        const jobId = await createJob()

        storedObject = null

        const res = await request(app.getHttpServer()).post(`/v1/jobs/${jobId}/analyze`).set(as(OWNER)).expect(409)
        const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set(as(OWNER)).expect(200)

        expect(res.body).toMatchObject({
            errorCode: RequestErrorCode.UploadIncomplete,
            message: 'The upload has not finished',
        })
        expect(job.body.job).toMatchObject({ status: JobStatus.Error, errorCode: JobErrorCode.UploadFailed })
        expect(deleteObject).not.toHaveBeenCalled()
        expect(dispatch).not.toHaveBeenCalled()
    })

    it("doesn't let another user start the job", async () => {
        const jobId = await createJob()
        const res = await request(app.getHttpServer()).post(`/v1/jobs/${jobId}/analyze`).set(as(STRANGER)).expect(404)
        const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set(as(OWNER)).expect(200)

        expect(res.body.errorCode).toBe(RequestErrorCode.NotFound)
        expect(job.body.job.status).toBe(JobStatus.Pending)
        expect(dispatch).not.toHaveBeenCalled()
    })

    it('rejects a video over the duration limit without charging, and deletes the upload', async () => {
        const jobId = await createJob()
        const before = await request(app.getHttpServer()).get('/v1/me/quota').set(as(OWNER))

        probe = { ...probe, durationS: MAX_DURATION_S + 1 }

        const res = await request(app.getHttpServer()).post(`/v1/jobs/${jobId}/analyze`).set(as(OWNER)).expect(422)
        const after = await request(app.getHttpServer()).get('/v1/me/quota').set(as(OWNER))
        const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set(as(OWNER))

        expect(res.body.errorCode).toBe(JobErrorCode.VideoTooLong)
        expect(job.body.job).toMatchObject({ status: JobStatus.Error, errorCode: JobErrorCode.VideoTooLong })
        expect(deleteObject.mock.calls).toEqual([[`users/${OWNER}/jobs/${jobId}/video`]])
        expect(after.body.quota.used).toBe(before.body.quota.used)
        expect(dispatch).not.toHaveBeenCalled()
    })

    it.each([
        ['storage', () => (storedObject = new Error('GCS 503'))],
        ['the prober', () => (probeFailure = new Error('Connection reset by peer'))],
    ])(
        'ends the job as VIDEO_CHECK_FAILED and keeps the upload in place when %s cannot be reached',
        async (_failing, fail) => {
            const jobId = await createJob()
            const before = await request(app.getHttpServer()).get('/v1/me/quota').set(as(OWNER))

            fail()

            const res = await request(app.getHttpServer()).post(`/v1/jobs/${jobId}/analyze`).set(as(OWNER)).expect(503)
            const after = await request(app.getHttpServer()).get('/v1/me/quota').set(as(OWNER))
            const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set(as(OWNER))

            expect(res.body).toMatchObject({
                errorCode: RequestErrorCode.Unavailable,
                message: 'The upload could not be checked',
            })
            expect(job.body.job).toMatchObject({ status: JobStatus.Error, errorCode: JobErrorCode.VideoCheckFailed })
            expect(after.body.quota.used).toBe(before.body.quota.used)
            expect(deleteObject).not.toHaveBeenCalled()
            expect(dispatch).not.toHaveBeenCalled()
        },
    )

    it('ends the job as ANALYSIS_FAILED, refunded, when the worker cannot be started', async () => {
        const jobId = await createJob()
        const before = await request(app.getHttpServer()).get('/v1/me/quota').set(as(OWNER))

        dispatch.mockRejectedValueOnce(new Error('Cloud Run unavailable'))

        const res = await request(app.getHttpServer()).post(`/v1/jobs/${jobId}/analyze`).set(as(OWNER)).expect(503)
        const after = await request(app.getHttpServer()).get('/v1/me/quota').set(as(OWNER))
        const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set(as(OWNER))

        expect(res.body.errorCode).toBe(RequestErrorCode.Unavailable)
        expect(after.body.quota.used).toBe(before.body.quota.used)
        expect(job.body.job).toMatchObject({ status: JobStatus.Error, errorCode: JobErrorCode.AnalysisFailed })
    })

    it("pages the user's own job list newest first", async () => {
        const created: string[] = []

        for (let i = 0; i < 3; i++) {
            const res = await request(app.getHttpServer())
                .post('/v1/jobs')
                .set(as(PAGER))
                .send({ settings: SETTINGS, file: FILE })
                .expect(201)

            created.push(res.body.job.id)
        }

        const first = await request(app.getHttpServer()).get('/v1/jobs?limit=2').set(as(PAGER)).expect(200)
        const second = await request(app.getHttpServer())
            .get(`/v1/jobs?limit=2&cursor=${first.body.nextCursor}`)
            .set(as(PAGER))
            .expect(200)

        expect(first.body.jobs.map((job: { id: string }) => job.id)).toEqual([created[2], created[1]])
        expect(second.body.jobs.map((job: { id: string }) => job.id)).toEqual([created[0]])
        expect(second.body.nextCursor).toBeNull()
    })

    describe('sample ads', () => {
        const SAMPLE_MEDIA = {
            durationS: 15,
            width: 1920,
            height: 1080,
            hasAudio: true,
            sizeBytes: 4_000_000,
            contentType: VideoMimeType.Mp4,
        }
        let samples: Model<SampleDoc>
        let sampleId: string

        beforeAll(async () => {
            samples = app.get(getModelToken(SAMPLE_MODEL))

            const [published] = await samples.create([
                {
                    slug: 'running-shoes',
                    title: 'Running shoes',
                    description: 'A 15-second product spot',
                    file: {
                        name: 'running-shoes.mp4',
                        contentType: VideoMimeType.Mp4,
                        size: 4_000_000,
                        bucket: 'test-bucket',
                        path: 'samples/running-shoes.mp4',
                    },
                    media: SAMPLE_MEDIA,
                    settings: { platforms: ['YouTube'], placements: ['youtube_shorts'], markets: ['US'] },
                    order: 1,
                },
                {
                    slug: 'hidden',
                    title: 'Unpublished',
                    description: 'Not listed',
                    file: {
                        name: 'hidden.mp4',
                        contentType: VideoMimeType.Mp4,
                        size: 1000,
                        bucket: 'test-bucket',
                        path: 'samples/hidden.mp4',
                    },
                    media: SAMPLE_MEDIA,
                    settings: {},
                    isPublished: false,
                },
            ])

            sampleId = published._id.toString()
        })

        it('lists published samples to anyone, with a preview URL and no storage path', async () => {
            const res = await request(app.getHttpServer()).get('/v1/samples').expect(200)

            expect(res.body.samples).toHaveLength(1)
            expect(res.body.samples[0]).toMatchObject({
                id: sampleId,
                title: 'Running shoes',
                settings: { platforms: ['YouTube'] },
                media: { durationS: 15 },
                previewUrl: 'https://storage.googleapis.com/signed-read',
            })
            expect(JSON.stringify(res.body)).not.toContain('samples/running-shoes.mp4')
        })

        it('creates a sample job with the sample media and the chosen settings', async () => {
            const res = await request(app.getHttpServer())
                .post('/v1/jobs/from-sample')
                .set(as(SAMPLER))
                .send({ sampleId, settings: SETTINGS })
                .expect(201)

            expect(res.body.job).toMatchObject({
                status: JobStatus.Pending,
                sampleId,
                settings: SETTINGS,
                media: { durationS: 15 },
                file: { name: 'running-shoes.mp4' },
            })
        })

        it('refuses an unknown or unpublished sample', async () => {
            const hidden = await samples.findOne({ slug: 'hidden' })

            for (const id of ['64b000000000000000000000', 'not-an-id', hidden!._id.toString()]) {
                const res = await request(app.getHttpServer())
                    .post('/v1/jobs/from-sample')
                    .set(as(SAMPLER))
                    .send({ sampleId: id, settings: SETTINGS })
                    .expect(404)

                expect(res.body.errorCode).toBe(RequestErrorCode.NotFound)
            }
        })

        it('starts a sample job without verifying an upload, and charges it', async () => {
            const created = await request(app.getHttpServer())
                .post('/v1/jobs/from-sample')
                .set(as(SAMPLER))
                .send({ sampleId, settings: SETTINGS })
                .expect(201)
            const jobId = created.body.job.id

            storedObject = null

            const res = await request(app.getHttpServer())
                .post(`/v1/jobs/${jobId}/analyze`)
                .set(as(SAMPLER))
                .expect(202)
            const quota = await request(app.getHttpServer()).get('/v1/me/quota').set(as(SAMPLER)).expect(200)

            expect(res.body.job).toMatchObject({ status: JobStatus.Queued, sampleId })
            expect(dispatch).toHaveBeenCalledWith(jobId)
            expect(quota.body.quota.used).toBe(1)
        })

        it('ends a sample job as VIDEO_CHECK_FAILED when its sample has been removed', async () => {
            const created = await request(app.getHttpServer())
                .post('/v1/jobs/from-sample')
                .set(as(SAMPLER))
                .send({ sampleId, settings: SETTINGS })
                .expect(201)

            await samples.updateOne({ _id: sampleId }, { $set: { 'file.path': 'samples/moved.mp4' } })

            const res = await request(app.getHttpServer())
                .post(`/v1/jobs/${created.body.job.id}/analyze`)
                .set(as(SAMPLER))
                .expect(404)
            const job = await request(app.getHttpServer()).get(`/v1/jobs/${created.body.job.id}`).set(as(SAMPLER))

            await samples.updateOne({ _id: sampleId }, { $set: { 'file.path': 'samples/running-shoes.mp4' } })

            expect(res.body.errorCode).toBe(RequestErrorCode.NotFound)
            expect(job.body.job).toMatchObject({ status: JobStatus.Error, errorCode: JobErrorCode.VideoCheckFailed })
            expect(dispatch).not.toHaveBeenCalled()
        })

        it('deletes a sample analysis without touching the shared sample video', async () => {
            const created = await request(app.getHttpServer())
                .post('/v1/jobs/from-sample')
                .set(as(SAMPLER))
                .send({ sampleId, settings: SETTINGS })
                .expect(201)

            await request(app.getHttpServer()).delete(`/v1/jobs/${created.body.job.id}`).set(as(SAMPLER)).expect(204)

            expect(deleteObject).not.toHaveBeenCalled()
        })
    })

    describe('demos', () => {
        const DEMO_FILE = {
            name: 'kids-show-preview.mp4',
            contentType: VideoMimeType.Mp4,
            size: 4_000_000,
            bucket: 'test-bucket',
            path: 'demos/kids-show-preview.mp4',
        }
        const DEMO_MEDIA = {
            durationS: 50,
            width: 1920,
            height: 1080,
            hasAudio: true,
            sizeBytes: 4_000_000,
            contentType: VideoMimeType.Mp4,
        }
        const DEMO_ANALYSIS = {
            model: 'gemini',
            promptVersion: '7',
            rulesetVersion: '1.2.2',
            transcript: '',
            findings: [],
            metadataChecks: [],
            advisories: [],
            completedAt: '2026-10-07T10:00:00.000Z',
        }
        let jobs: Model<JobDoc>

        const buildDemoJob = (slug: string, order: number, overrides: Partial<JobDoc> = {}) => ({
            userId: DEMO_OWNER,
            status: JobStatus.Analyzed,
            settings: { platforms: ['Snapchat'], placements: [], markets: [] },
            file: { ...DEMO_FILE, path: `demos/${slug}.mp4` },
            media: DEMO_MEDIA,
            analysis: DEMO_ANALYSIS,
            chargedRunId: null,
            chargedIpRunId: null,
            demo: { slug, label: slug, title: `Title of ${slug}`, subtitle: 'Subtitle', order, isActive: true },
            ...overrides,
        })

        beforeAll(async () => {
            jobs = app.get(getModelToken(JOB_MODEL))

            await jobs.create(buildDemoJob('first', 1, { file: { ...DEMO_FILE, name: 'superseded.mp4' } }))
            await jobs.create([
                buildDemoJob('second', 2),
                buildDemoJob('first', 1),
                buildDemoJob('inactive', 0, {
                    demo: { slug: 'inactive', label: 'x', title: 'x', subtitle: 'x', order: 0, isActive: false },
                }),
                buildDemoJob('rerunning', 3, { status: JobStatus.Analyzing, analysis: undefined }),
            ])
        })

        it('lists the latest finished analysis of each active demo to anyone, in order, with a video URL', async () => {
            const res = await request(app.getHttpServer()).get('/v1/demos').expect(200)

            expect(res.body.demos.map((demo: { slug: string }) => demo.slug)).toEqual(['first', 'second'])
            expect(JSON.stringify(res.body)).not.toContain('superseded.mp4')
            expect(res.body.demos[0]).toMatchObject({
                slug: 'first',
                label: 'first',
                title: 'Title of first',
                subtitle: 'Subtitle',
                job: { status: JobStatus.Analyzed, media: { durationS: 50 }, analysis: { rulesetVersion: '1.2.2' } },
                videoUrl: 'https://storage.googleapis.com/signed-read',
            })
            expect(JSON.stringify(res.body)).not.toContain('demos/first.mp4')
            expect(res.body.demos[0].job).not.toHaveProperty('userId')
        })

        it('keeps demo jobs out of every user’s history', async () => {
            const res = await request(app.getHttpServer()).get('/v1/jobs').set(as(OWNER)).expect(200)

            expect(JSON.stringify(res.body)).not.toContain(DEMO_FILE.name)
        })
    })

    describe('deleting an analysis', () => {
        let jobs: Model<JobDoc>

        const createAs = async (userId: string): Promise<string> => {
            const res = await request(app.getHttpServer())
                .post('/v1/jobs')
                .set(as(userId))
                .send({ settings: SETTINGS, file: FILE })
                .expect(201)

            return res.body.job.id
        }

        beforeAll(() => {
            jobs = app.get(getModelToken(JOB_MODEL))
        })

        it('deletes a finished analysis and its uploaded video', async () => {
            const jobId = await createAs(DELETER)

            await jobs.updateOne({ _id: jobId }, { $set: { status: JobStatus.Analyzed } })
            await request(app.getHttpServer()).delete(`/v1/jobs/${jobId}`).set(as(DELETER)).expect(204)

            expect(deleteObject).toHaveBeenCalledWith(`users/${DELETER}/jobs/${jobId}/video`)
            await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set(as(DELETER)).expect(404)
        })

        it('deletes an analysis that never started', async () => {
            const jobId = await createAs(DELETER)

            await request(app.getHttpServer()).delete(`/v1/jobs/${jobId}`).set(as(DELETER)).expect(204)
            await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set(as(DELETER)).expect(404)
        })

        it("deletes an adopted analysis's video from the anonymous user's prefix it was uploaded under", async () => {
            const jobId = await createAs(DELETER)
            const path = `users/${new Types.ObjectId().toString()}/jobs/${jobId}/video`

            await jobs.updateOne({ _id: jobId }, { $set: { 'file.path': path } })
            await request(app.getHttpServer()).delete(`/v1/jobs/${jobId}`).set(as(DELETER)).expect(204)

            expect(deleteObject).toHaveBeenCalledWith(path)
        })

        it("refuses to delete another user's analysis", async () => {
            const jobId = await createAs(DELETER)
            const res = await request(app.getHttpServer()).delete(`/v1/jobs/${jobId}`).set(as(STRANGER)).expect(404)

            expect(res.body.errorCode).toBe(RequestErrorCode.NotFound)
            expect(deleteObject).not.toHaveBeenCalled()
        })

        it('refuses to delete an analysis while it runs', async () => {
            const jobId = await createAs(DELETER)

            await jobs.updateOne({ _id: jobId }, { $set: { status: JobStatus.Analyzing } })

            const res = await request(app.getHttpServer()).delete(`/v1/jobs/${jobId}`).set(as(DELETER)).expect(409)

            expect(res.body.errorCode).toBe(RequestErrorCode.JobInProgress)
            expect(deleteObject).not.toHaveBeenCalled()
            await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set(as(DELETER)).expect(200)
        })
    })

    describe('replaying the video', () => {
        const MEDIA = { durationS: 20, width: 1080, height: 1920, hasAudio: true, sizeBytes: FILE.size }
        let jobs: Model<JobDoc>

        beforeAll(() => {
            jobs = app.get(getModelToken(JOB_MODEL))
        })

        it('signs a read URL for a verified upload', async () => {
            const jobId = await createJob()

            await jobs.updateOne({ _id: jobId }, { $set: { media: { ...MEDIA, contentType: FILE.contentType } } })

            const res = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}/video`).set(as(OWNER)).expect(200)

            expect(res.body.url).toBe('https://storage.googleapis.com/signed-read')
        })

        it('answers not found once the cleanup deleted the video', async () => {
            const jobId = await createJob()

            await jobs.updateOne(
                { _id: jobId },
                { $set: { media: { ...MEDIA, contentType: FILE.contentType }, videoDeletedAt: new Date() } },
            )

            const res = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}/video`).set(as(OWNER)).expect(404)

            expect(res.body.errorCode).toBe(RequestErrorCode.NotFound)
        })
    })

    describe('contact messages', () => {
        const MESSAGE = {
            email: 'visitor@example.com',
            message: 'Hello, I would like to know more about AdLens.',
            challengeToken: 'pass',
        }
        let networks = 0

        // A network of its own per call unless one is given, so only the cap under test is reached.
        const nextNetwork = () => {
            networks++

            return `10.${Math.floor(networks / 250)}.${networks % 250}.1`
        }

        const sendContact = (body: Record<string, unknown>, network = nextNetwork()) =>
            request(app.getHttpServer()).post('/v1/contact').set({ 'x-forwarded-for': network }).send(body)

        beforeEach(async () => {
            await app.get<Connection>(getConnectionToken()).collection(RATE_LIMIT_COLLECTION).deleteMany({})
        })

        it('emails the message to the team without a session, replying to the sender', async () => {
            await sendContact(MESSAGE).expect(204)

            expect(sendMail).toHaveBeenCalledTimes(1)
            expect(sendMail.mock.calls[0][0]).toMatchObject({ to: 'team@adlens.test', replyTo: MESSAGE.email })
            expect(sendMail.mock.calls[0][0].text).toContain(MESSAGE.message)
        })

        it('escapes the message in the HTML version', async () => {
            await sendContact({ ...MESSAGE, message: '<script>alert(1)</script> hello there' }).expect(204)

            expect(sendMail.mock.calls[0][0].html).not.toContain('<script>')
        })

        it('accepts but drops a message that filled in the honeypot', async () => {
            await sendContact({ ...MESSAGE, website: 'https://spam.example' }).expect(204)

            expect(sendMail).not.toHaveBeenCalled()
        })

        it('rejects an invalid message', async () => {
            const res = await sendContact({ email: 'nope', message: 'hi' }).expect(400)

            expect(res.body.errorCode).toBe(RequestErrorCode.ValidationFailed)
        })

        it('checks the Turnstile token against the network address', async () => {
            await sendContact(MESSAGE, '192.0.2.77').expect(204)

            expect(verifyChallenge).toHaveBeenCalledWith('pass', '192.0.2.77')
        })

        it('refuses a message whose Turnstile check fails, and sends nothing', async () => {
            const res = await sendContact({ ...MESSAGE, challengeToken: 'fail' }).expect(403)

            expect(res.body.errorCode).toBe(RequestErrorCode.ChallengeFailed)
            expect(sendMail).not.toHaveBeenCalled()
        })

        it("doesn't count a message whose Turnstile check failed", async () => {
            for (let attempt = 0; attempt < 3; attempt++) {
                await sendContact({ ...MESSAGE, challengeToken: 'fail' }, '192.0.2.60').expect(403)
            }

            await sendContact(MESSAGE, '192.0.2.60').expect(204)
        })

        it('needs either a Turnstile token or an upload draft', async () => {
            const { challengeToken: _challengeToken, ...withoutToken } = MESSAGE
            const res = await sendContact(withoutToken).expect(400)

            expect(res.body.errorCode).toBe(RequestErrorCode.ValidationFailed)
            expect(sendMail).not.toHaveBeenCalled()
        })

        it('refuses an unknown upload draft', async () => {
            const { challengeToken: _challengeToken, ...withoutToken } = MESSAGE
            const res = await sendContact({ ...withoutToken, draftId: 'no-such-draft' }).expect(400)

            expect(res.body.errorCode).toBe(RequestErrorCode.ValidationFailed)
            expect(sendMail).not.toHaveBeenCalled()
        })

        it('limits how often one sender can write, from any network', async () => {
            for (let sent = 0; sent < 3; sent++) {
                await sendContact(MESSAGE).expect(204)
            }

            const res = await sendContact(MESSAGE).expect(429)

            expect(res.body.errorCode).toBe(RequestErrorCode.RateLimited)
            expect(sendMail).toHaveBeenCalledTimes(3)
        })

        it('limits how often one network can write, whoever sends it', async () => {
            for (let sent = 0; sent < 3; sent++) {
                await sendContact({ ...MESSAGE, email: `writer${sent}@example.com` }, '192.0.2.50').expect(204)
            }

            const res = await sendContact({ ...MESSAGE, email: 'writer9@example.com' }, '192.0.2.50').expect(429)

            expect(res.body.errorCode).toBe(RequestErrorCode.RateLimited)
            expect(sendMail).toHaveBeenCalledTimes(3)
        })

        it('caps the total number of messages per hour, even when they arrive at once', async () => {
            const responses = await Promise.all(
                Array.from({ length: 24 }, (_, index) =>
                    sendContact({ ...MESSAGE, email: `sender${index}@example.com` }),
                ),
            )
            const statuses = responses.map((res) => res.status)

            expect(statuses.filter((status) => status === 204)).toHaveLength(20)
            expect(statuses.filter((status) => status === 429)).toHaveLength(4)
            expect(sendMail).toHaveBeenCalledTimes(20)
        })

        it("doesn't let one sender's concurrent messages exceed the cap", async () => {
            const responses = await Promise.all(Array.from({ length: 6 }, () => sendContact(MESSAGE)))

            expect(responses.filter((res) => res.status === 204)).toHaveLength(3)
            expect(sendMail).toHaveBeenCalledTimes(3)
        })

        describe('with images', () => {
            const PNG = { name: 'screenshot.png', contentType: 'image/png', size: 1200 }
            const JPEG = { name: 'photo', contentType: 'image/jpeg', size: 800 }
            const { challengeToken: _challengeToken, ...VISITOR } = MESSAGE
            let contactDrafts: Model<ContactDraftDoc>

            const createUploads = (body: Record<string, unknown>, network = nextNetwork()) =>
                request(app.getHttpServer()).post('/v1/contact/uploads').set({ 'x-forwarded-for': network }).send(body)

            // Uploads the declared files as the browser would, then answers the draft id.
            const uploadDraft = async (files = [PNG, JPEG]): Promise<string> => {
                const res = await createUploads({ files, challengeToken: 'pass' }).expect(201)
                const draft = await contactDrafts.findById(res.body.draftId).lean()

                draft?.files.forEach((file, index) => {
                    contactObjects.set(file.path, {
                        contentType: file.contentType,
                        content: Buffer.alloc(files[index].size, index + 1),
                    })
                })

                return res.body.draftId
            }

            beforeAll(() => {
                contactDrafts = app.get(getModelToken(CONTACT_DRAFT_MODEL))
            })

            beforeEach(async () => {
                await contactDrafts.deleteMany({})
                contactObjects.clear()
            })

            it('answers a draft and one signed upload per image, in order, under the draft folder', async () => {
                const res = await createUploads({ files: [PNG, JPEG], challengeToken: 'pass' }).expect(201)

                expect(res.body.uploads).toHaveLength(2)
                expect(res.body.uploads[0].headers).toMatchObject({
                    'Content-Type': PNG.contentType,
                    'x-goog-content-length-range': `${PNG.size},${PNG.size}`,
                })
                expect(res.body.uploads[1].headers).toMatchObject({ 'Content-Type': JPEG.contentType })

                const draft = await contactDrafts.findById(res.body.draftId).lean()

                expect(draft?.files).toEqual([
                    { ...PNG, path: `contact/${res.body.draftId}/0.png` },
                    { ...JPEG, path: `contact/${res.body.draftId}/1.jpg` },
                ])
                expect(draft?.usedAt).toBeNull()
                expect(draft?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 59 * 60 * 1000)
                expect(draft?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000)
            })

            it('refuses uploads whose Turnstile check fails', async () => {
                const res = await createUploads({ files: [PNG], challengeToken: 'fail' }).expect(403)

                expect(res.body.errorCode).toBe(RequestErrorCode.ChallengeFailed)
                expect(await contactDrafts.countDocuments()).toBe(0)
            })

            it('refuses images the contract does not allow', async () => {
                const gif = { ...PNG, contentType: 'image/gif' }
                const tooMany = Array.from({ length: 6 }, () => PNG)
                const tooLarge = Array.from({ length: 4 }, () => ({ ...PNG, size: 7_000_000 }))

                for (const files of [[gif], tooMany, tooLarge, []]) {
                    const res = await createUploads({ files, challengeToken: 'pass' }).expect(400)

                    expect(res.body.errorCode).toBe(RequestErrorCode.ValidationFailed)
                }
            })

            it('allows 3 upload drafts per network an hour', async () => {
                for (let draft = 0; draft < 3; draft++) {
                    await createUploads({ files: [PNG], challengeToken: 'pass' }, '192.0.2.90').expect(201)
                }

                const res = await createUploads({ files: [PNG], challengeToken: 'pass' }, '192.0.2.90').expect(429)

                expect(res.body.errorCode).toBe(RequestErrorCode.RateLimited)
            })

            it('attaches the uploaded images, and the draft stands in for the Turnstile check', async () => {
                const draftId = await uploadDraft()

                verifyChallenge.mockClear()
                await sendContact({ ...VISITOR, draftId }).expect(204)

                expect(verifyChallenge).not.toHaveBeenCalled()
                expect(sendMail).toHaveBeenCalledTimes(1)
                expect(sendMail.mock.calls[0][0].attachments).toEqual([
                    { filename: 'screenshot.png', content: Buffer.alloc(PNG.size, 1) },
                    { filename: 'photo.jpg', content: Buffer.alloc(JPEG.size, 2) },
                ])
            })

            it('uses a draft only once, even when it is sent twice at once', async () => {
                const draftId = await uploadDraft()
                const responses = await Promise.all([
                    sendContact({ ...VISITOR, draftId }),
                    sendContact({ ...VISITOR, draftId }),
                ])

                expect(responses.map((res) => res.status).sort()).toEqual([204, 400])
                expect(sendMail).toHaveBeenCalledTimes(1)

                const res = await sendContact({ ...VISITOR, draftId }).expect(400)

                expect(res.body.errorCode).toBe(RequestErrorCode.ValidationFailed)
            })

            it('refuses an expired draft', async () => {
                const draftId = await uploadDraft()

                await contactDrafts.updateOne({ _id: draftId }, { $set: { expiresAt: new Date(Date.now() - 1000) } })

                const res = await sendContact({ ...VISITOR, draftId }).expect(400)

                expect(res.body.errorCode).toBe(RequestErrorCode.ValidationFailed)
                expect(sendMail).not.toHaveBeenCalled()
            })

            it('refuses a draft whose image never arrived, and sends nothing', async () => {
                const draftId = await uploadDraft()

                contactObjects.delete(`contact/${draftId}/1.jpg`)

                const res = await sendContact({ ...VISITOR, draftId }).expect(400)

                expect(res.body.errorCode).toBe(RequestErrorCode.ValidationFailed)
                expect(sendMail).not.toHaveBeenCalled()
            })

            it('refuses a draft whose image differs from the one declared', async () => {
                const smaller = await uploadDraft()

                contactObjects.set(`contact/${smaller}/0.png`, {
                    contentType: PNG.contentType,
                    content: Buffer.alloc(PNG.size - 1),
                })
                await sendContact({ ...VISITOR, draftId: smaller }).expect(400)

                const retyped = await uploadDraft()

                contactObjects.set(`contact/${retyped}/0.png`, {
                    contentType: 'image/gif',
                    content: Buffer.alloc(PNG.size),
                })
                await sendContact({ ...VISITOR, draftId: retyped }).expect(400)

                expect(sendMail).not.toHaveBeenCalled()
            })

            it("doesn't count a message whose images were refused", async () => {
                for (let sent = 0; sent < 2; sent++) {
                    await sendContact(MESSAGE).expect(204)
                }

                const draftId = await uploadDraft()

                contactObjects.delete(`contact/${draftId}/0.png`)
                await sendContact({ ...VISITOR, draftId }).expect(400)
                await sendContact(MESSAGE).expect(204)

                expect(sendMail).toHaveBeenCalledTimes(3)
            })

            it('answers 503 and sends nothing when storage fails', async () => {
                const draftId = await uploadDraft()

                contactObjects.set(`contact/${draftId}/0.png`, new Error('GCS 503'))

                const res = await sendContact({ ...VISITOR, draftId }).expect(503)

                expect(res.body.errorCode).toBe(RequestErrorCode.Unavailable)
                expect(sendMail).not.toHaveBeenCalled()
            })

            it('refuses a message with both a Turnstile token and a draft', async () => {
                const draftId = await uploadDraft()
                const res = await sendContact({ ...MESSAGE, draftId }).expect(400)

                expect(res.body.errorCode).toBe(RequestErrorCode.ValidationFailed)
            })
        })
    })

    describe('analysis without an account and the network limits', () => {
        const MEMBER = new Types.ObjectId().toString()
        const ADMIN = new Types.ObjectId().toString()
        const LIMITED = new Types.ObjectId().toString()

        const addUser = async (fields: Record<string, unknown>): Promise<string> => {
            const _id = new Types.ObjectId()

            await app
                .get<Connection>(getConnectionToken())
                .collection(USER_COLLECTION)
                .insertOne({ _id, email: `${_id.toString()}@example.com`, ...fields })

            return _id.toString()
        }

        // A fresh one per test, so no test spends another's analyses.
        const addAnonymous = () => addUser({ isAnonymous: true, emailVerified: false })
        const addUnconfirmed = () => addUser({ isAnonymous: false, emailVerified: false })

        // The client's own entry comes first; the rightmost one is what Google's front end appends.
        const from = (network: string) => ({ 'x-forwarded-for': `198.51.100.99, ${network}` })

        const createFrom = (userId: string, network: string, body: Record<string, unknown> = {}) =>
            request(app.getHttpServer())
                .post('/v1/jobs')
                .set({ ...as(userId), ...from(network) })
                .send({ settings: SETTINGS, file: FILE, ...body })

        const analyzeFrom = (userId: string, network: string, jobId: string) =>
            request(app.getHttpServer())
                .post(`/v1/jobs/${jobId}/analyze`)
                .set({ ...as(userId), ...from(network) })

        const networkKey = (network: string) =>
            app.get(ClientNetworkResolver).resolve({ forwardedFor: network, socketAddress: undefined }).bucketKey

        const usage = (network: string) => app.get(IpQuotaService).usage(networkKey(network))

        const seedNetwork = async (network: string, runs: number, access = UserAccess.Member) => {
            const bucketKey = networkKey(network)

            for (let i = 0; i < runs; i++) {
                await app.get(IpQuotaService).charge({ bucketKey, access, hasPassedChallenge: true }, `seed-${i}`)
            }
        }

        beforeAll(async () => {
            await app
                .get<Connection>(getConnectionToken())
                .collection(USER_COLLECTION)
                .insertMany([
                    { _id: new Types.ObjectId(MEMBER), email: 'member@example.com', emailVerified: true },
                    { _id: new Types.ObjectId(ADMIN), email: 'admin@example.com', isAdmin: true, emailVerified: true },
                    {
                        _id: new Types.ObjectId(LIMITED),
                        email: 'limited@example.com',
                        emailVerified: true,
                        runs: [0, 1, 2].map((i) => ({ id: `run-${i}`, startedAt: new Date(), jobId: `job-${i}` })),
                    },
                ])
        })

        it('lets an anonymous user analyze once the challenge passes, checking it with their address', async () => {
            const anonymous = await addAnonymous()
            const created = await createFrom(anonymous, '203.0.113.1', { challengeToken: 'pass' }).expect(201)

            await analyzeFrom(anonymous, '203.0.113.1', created.body.job.id).expect(202)

            expect(verifyChallenge).toHaveBeenCalledWith('pass', '203.0.113.1')
            expect(await usage('203.0.113.1')).toEqual({ total: 1, anonymous: 1 })
        })

        it('asks an anonymous user for the challenge and refuses a failed one', async () => {
            const anonymous = await addAnonymous()
            const missing = await createFrom(anonymous, '203.0.113.2').expect(403)
            const failed = await createFrom(anonymous, '203.0.113.2', { challengeToken: 'fail' }).expect(403)

            expect(missing.body.errorCode).toBe(RequestErrorCode.ChallengeRequired)
            expect(failed.body.errorCode).toBe(RequestErrorCode.ChallengeFailed)
        })

        it('checks a sample job before looking the sample up', async () => {
            const anonymous = await addAnonymous()
            const res = await request(app.getHttpServer())
                .post('/v1/jobs/from-sample')
                .set({ ...as(anonymous), ...from('203.0.113.2') })
                .send({ sampleId: '64b000000000000000000000', settings: SETTINGS })
                .expect(403)

            expect(res.body.errorCode).toBe(RequestErrorCode.ChallengeRequired)
        })

        it('asks for sign-up once the network used its anonymous analyses, but lets members in', async () => {
            await seedNetwork('203.0.113.3', 3, UserAccess.Anonymous)

            const anonymous = await createFrom(await addAnonymous(), '203.0.113.3', { challengeToken: 'pass' }).expect(
                429,
            )

            await createFrom(MEMBER, '203.0.113.3').expect(201)
            expect(anonymous.body.errorCode).toBe(RequestErrorCode.SignUpRequired)
        })

        describe('one free analysis per browser', () => {
            const usedBy = (userId: string) => ({ Cookie: `adlens_free_run=${userId}` })

            const createWithCookie = (userId: string, network: string, freeRunUserId: string) =>
                request(app.getHttpServer())
                    .post('/v1/jobs')
                    .set({ ...as(userId), ...from(network), ...usedBy(freeRunUserId) })
                    .send({ settings: SETTINGS, file: FILE, challengeToken: 'pass' })

            const freeRunCookieOf = (res: { headers: Record<string, unknown> }) =>
                ([res.headers['set-cookie']].flat().filter(Boolean) as string[]).find((cookie) =>
                    cookie.startsWith('adlens_free_run='),
                )

            it('remembers which user used it, for 400 days, in a cookie scripts can’t read', async () => {
                const anonymous = await addAnonymous()
                const created = await createFrom(anonymous, '203.0.113.30', { challengeToken: 'pass' }).expect(201)
                const started = await analyzeFrom(anonymous, '203.0.113.30', created.body.job.id).expect(202)

                expect(freeRunCookieOf(started)).toMatch(
                    new RegExp(`^adlens_free_run=${anonymous};.*Max-Age=${400 * 24 * 60 * 60};.*HttpOnly`),
                )
            })

            it('counts an account’s analysis as the browser’s too', async () => {
                const member = await addUser({ isAnonymous: false, emailVerified: true })
                const created = await createFrom(member, '203.0.113.31').expect(201)
                const started = await analyzeFrom(member, '203.0.113.31', created.body.job.id).expect(202)

                expect(freeRunCookieOf(started)).toMatch(new RegExp(`^adlens_free_run=${member};`))
            })

            it('asks a visitor or a new anonymous session in that browser to sign in, in advance and at creation', async () => {
                const used = new Types.ObjectId().toString()
                const visitor = await request(app.getHttpServer())
                    .get('/v1/admission')
                    .set({ ...from('203.0.113.32'), ...usedBy(used) })
                    .expect(429)
                const another = await createWithCookie(await addAnonymous(), '203.0.113.32', used).expect(429)

                expect(visitor.body.errorCode).toBe(RequestErrorCode.SignUpRequired)
                expect(another.body.errorCode).toBe(RequestErrorCode.SignUpRequired)
            })

            it('asks an unconfirmed account in that browser to confirm its email, in advance and at creation', async () => {
                const used = new Types.ObjectId().toString()
                const unconfirmed = await addUser({ isAnonymous: false, emailVerified: false })
                const ahead = await request(app.getHttpServer())
                    .get('/v1/admission')
                    .set({ ...as(unconfirmed), ...from('203.0.113.34'), ...usedBy(used) })
                    .expect(429)
                const created = await createWithCookie(unconfirmed, '203.0.113.34', used).expect(429)

                expect(ahead.body.errorCode).toBe(RequestErrorCode.EmailConfirmationRequired)
                expect(created.body.errorCode).toBe(RequestErrorCode.EmailConfirmationRequired)
            })

            it('lets the user that used it retry a refunded run, and never limits a confirmed account', async () => {
                const anonymous = await addAnonymous()

                await createWithCookie(anonymous, '203.0.113.33', anonymous).expect(201)
                await createWithCookie(MEMBER, '203.0.113.33', anonymous).expect(201)
            })

            // The run the cookie names: started, then failed and refunded.
            const runAndRefund = async (userId: string, network: string): Promise<string> => {
                const created = await createFrom(userId, network, { challengeToken: 'pass' }).expect(201)
                const jobId = created.body.job.id

                await analyzeFrom(userId, network, jobId).expect(202)
                await app.get(JobLifecycle).fail(jobId, JobErrorCode.AnalysisFailed, 'failed')

                return jobId
            }

            const admissionWithCookie = (network: string, freeRunUserId: string, userId?: string) =>
                request(app.getHttpServer())
                    .get('/v1/admission')
                    .set({ ...(userId ? as(userId) : {}), ...from(network), ...usedBy(freeRunUserId) })

            it('lets the browser run again once the anonymous run it remembers was refunded, not before', async () => {
                const anonymous = await addAnonymous()
                const created = await createFrom(anonymous, '203.0.113.35', { challengeToken: 'pass' }).expect(201)

                await analyzeFrom(anonymous, '203.0.113.35', created.body.job.id).expect(202)
                const held = await admissionWithCookie('203.0.113.35', anonymous, await addAnonymous()).expect(429)
                await app.get(JobLifecycle).fail(created.body.job.id, JobErrorCode.AnalysisFailed, 'failed')

                await admissionWithCookie('203.0.113.35', anonymous).expect(204)
                await createWithCookie(await addAnonymous(), '203.0.113.35', anonymous).expect(201)
                expect(held.body.errorCode).toBe(RequestErrorCode.SignUpRequired)
            })

            it('admits the account an anonymous user with a refunded run linked to, which the cookie then names', async () => {
                const anonymous = await addAnonymous()
                const account = await addUnconfirmed()

                await runAndRefund(anonymous, '203.0.113.36')
                // What linking does: the account adopts the anonymous user's data, the anonymous user is deleted and
                // the cookie is moved to the account (auth-flow tests cover the move through Better Auth).
                await app.get(AccountDataService).adopt(anonymous, account)
                await app
                    .get<Connection>(getConnectionToken())
                    .collection(USER_COLLECTION)
                    .deleteOne({ _id: new Types.ObjectId(anonymous) })

                await admissionWithCookie('203.0.113.36', account, account).expect(204)
                await admissionWithCookie('203.0.113.36', account, await addAnonymous()).expect(204)
            })

            it('still counts a refunded run of a confirmed account, or of a user that is gone', async () => {
                const member = await addUser({ isAnonymous: false, emailVerified: true })
                const gone = await addAnonymous()

                await runAndRefund(member, '203.0.113.37')
                await runAndRefund(gone, '203.0.113.38')
                await app
                    .get<Connection>(getConnectionToken())
                    .collection(USER_COLLECTION)
                    .deleteOne({ _id: new Types.ObjectId(gone) })

                await admissionWithCookie('203.0.113.37', member, await addAnonymous()).expect(429)
                await admissionWithCookie('203.0.113.38', gone, await addAnonymous()).expect(429)
                await admissionWithCookie('203.0.113.38', 'not-an-id', await addAnonymous()).expect(429)
            })

            it('refuses to start a job made before another user in the browser used the analysis', async () => {
                const unconfirmed = await addUnconfirmed()
                const other = await addAnonymous()
                const pending = await createFrom(unconfirmed, '203.0.113.39', { challengeToken: 'pass' }).expect(201)
                const othersJob = await createFrom(other, '203.0.113.39', { challengeToken: 'pass' }).expect(201)

                await analyzeFrom(other, '203.0.113.39', othersJob.body.job.id).expect(202)
                const refused = await request(app.getHttpServer())
                    .post(`/v1/jobs/${pending.body.job.id}/analyze`)
                    .set({ ...as(unconfirmed), ...from('203.0.113.39'), ...usedBy(other) })
                    .expect(429)
                const job = await request(app.getHttpServer())
                    .get(`/v1/jobs/${pending.body.job.id}`)
                    .set(as(unconfirmed))
                    .expect(200)

                expect(refused.body.errorCode).toBe(RequestErrorCode.EmailConfirmationRequired)
                expect(job.body.job).toMatchObject({ status: JobStatus.Error, errorCode: JobErrorCode.AnalysisFailed })
                expect(await usage('203.0.113.39')).toEqual({ total: 1, anonymous: 1 })
            })
        })

        describe('the admission check', () => {
            const admissionFrom = (network: string, userId?: string) =>
                request(app.getHttpServer())
                    .get('/v1/admission')
                    .set({ ...(userId ? as(userId) : {}), ...from(network) })

            it('admits a visitor without a session, whose first analysis only needs the challenge', async () => {
                await admissionFrom('203.0.113.20').expect(204)
            })

            it('refuses a visitor once the network used its anonymous analyses, as creating the job would', async () => {
                await seedNetwork('203.0.113.21', 3, UserAccess.Anonymous)

                const visitor = await admissionFrom('203.0.113.21').expect(429)
                const anonymous = await admissionFrom('203.0.113.21', await addAnonymous()).expect(429)

                await admissionFrom('203.0.113.21', MEMBER).expect(204)
                expect(visitor.body.errorCode).toBe(RequestErrorCode.SignUpRequired)
                expect(anonymous.body.errorCode).toBe(RequestErrorCode.SignUpRequired)
            })

            it('refuses a member whose own quota is spent', async () => {
                const res = await admissionFrom('203.0.113.22', LIMITED).expect(429)

                expect(res.body.errorCode).toBe(RequestErrorCode.QuotaExceeded)
            })

            it('refuses everyone but an admin on a network at its hard limit', async () => {
                await seedNetwork('203.0.113.23', 30)

                const member = await admissionFrom('203.0.113.23', MEMBER).expect(429)

                await admissionFrom('203.0.113.23', ADMIN).expect(204)
                expect(member.body.errorCode).toBe(RequestErrorCode.NetworkQuotaExceeded)
            })

            it('charges and verifies nothing', async () => {
                await admissionFrom('203.0.113.24', await addAnonymous()).expect(204)

                expect(await usage('203.0.113.24')).toEqual({ total: 0, anonymous: 0 })
                expect(verifyChallenge).not.toHaveBeenCalledWith(expect.anything(), '203.0.113.24')
            })
        })

        it('always asks an unconfirmed account for the challenge, and counts its analysis as anonymous', async () => {
            const unconfirmed = await addUnconfirmed()
            const missing = await createFrom(unconfirmed, '203.0.113.10').expect(403)
            const created = await createFrom(unconfirmed, '203.0.113.10', { challengeToken: 'pass' }).expect(201)

            await analyzeFrom(unconfirmed, '203.0.113.10', created.body.job.id).expect(202)

            expect(missing.body.errorCode).toBe(RequestErrorCode.ChallengeRequired)
            expect(await usage('203.0.113.10')).toEqual({ total: 1, anonymous: 1 })
        })

        it('asks an unconfirmed account to confirm its email once the network used its anonymous analyses', async () => {
            await seedNetwork('203.0.113.11', 3, UserAccess.Anonymous)

            const res = await createFrom(await addUnconfirmed(), '203.0.113.11', { challengeToken: 'pass' }).expect(429)

            expect(res.body.errorCode).toBe(RequestErrorCode.EmailConfirmationRequired)
        })

        it('asks everyone for the challenge once the network passes the soft limit', async () => {
            await seedNetwork('203.0.113.4', 10)

            const unchecked = await createFrom(MEMBER, '203.0.113.4').expect(403)
            const checked = await createFrom(MEMBER, '203.0.113.4', { challengeToken: 'pass' }).expect(201)

            await analyzeFrom(MEMBER, '203.0.113.4', checked.body.job.id).expect(202)

            expect(unchecked.body.errorCode).toBe(RequestErrorCode.ChallengeRequired)
            expect((await usage('203.0.113.4')).total).toBe(11)
        })

        it('stops a network at the hard limit, except for admins', async () => {
            await seedNetwork('203.0.113.5', 30)

            const member = await createFrom(MEMBER, '203.0.113.5').expect(429)
            const created = await createFrom(ADMIN, '203.0.113.5').expect(201)

            await analyzeFrom(ADMIN, '203.0.113.5', created.body.job.id).expect(202)

            expect(member.body.errorCode).toBe(RequestErrorCode.NetworkQuotaExceeded)
            expect((await usage('203.0.113.5')).total).toBe(30)
        })

        it('only calls Turnstile when a rule requires it, whatever token the client sends', async () => {
            await seedNetwork('203.0.113.9', 10)

            await createFrom(MEMBER, '203.0.113.8', { challengeToken: 'fail' }).expect(201)
            await createFrom(ADMIN, '203.0.113.9', { challengeToken: 'fail' }).expect(201)

            expect(verifyChallenge).not.toHaveBeenCalled()
        })

        it('gives an anonymous user one analysis, then asks them to sign up', async () => {
            const anonymous = await addAnonymous()
            const created = await createFrom(anonymous, '203.0.113.12', { challengeToken: 'pass' }).expect(201)

            await analyzeFrom(anonymous, '203.0.113.12', created.body.job.id).expect(202)

            const next = await createFrom(anonymous, '203.0.113.13', { challengeToken: 'pass' }).expect(429)
            const quota = await request(app.getHttpServer()).get('/v1/me/quota').set(as(anonymous)).expect(200)

            // The report shows the weekly allowance; the one analysis before confirmation is enforced on its own.
            expect(next.body.errorCode).toBe(RequestErrorCode.SignUpRequired)
            expect(quota.body.quota).toMatchObject({ used: 1, limit: 3 })
        })

        it('gives an unconfirmed account one analysis, then asks it to confirm its email', async () => {
            const unconfirmed = await addUnconfirmed()
            const created = await createFrom(unconfirmed, '203.0.113.14', { challengeToken: 'pass' }).expect(201)

            await analyzeFrom(unconfirmed, '203.0.113.14', created.body.job.id).expect(202)

            const next = await createFrom(unconfirmed, '203.0.113.15', { challengeToken: 'pass' }).expect(429)
            const quota = await request(app.getHttpServer()).get('/v1/me/quota').set(as(unconfirmed)).expect(200)

            expect(next.body.errorCode).toBe(RequestErrorCode.EmailConfirmationRequired)
            expect(quota.body.quota).toMatchObject({ used: 1, limit: 3 })
        })

        it('refuses a new job once the user has no analyses left', async () => {
            const res = await createFrom(LIMITED, '203.0.113.6').expect(429)

            expect(res.body.errorCode).toBe(RequestErrorCode.QuotaExceeded)
        })

        it('ends a job refused at charging as ANALYSIS_FAILED, with nothing charged', async () => {
            const user = await addUser({ emailVerified: true })
            const created = await createFrom(user, '203.0.113.16').expect(201)

            // Spent between creating the job, which the admission check allowed, and starting it.
            await app
                .get<Connection>(getConnectionToken())
                .collection(USER_COLLECTION)
                .updateOne(
                    { _id: new Types.ObjectId(user) },
                    {
                        $set: {
                            runs: [0, 1, 2].map((i) => ({ id: `run-${i}`, startedAt: new Date(), jobId: `job-${i}` })),
                        },
                    },
                )

            const res = await analyzeFrom(user, '203.0.113.16', created.body.job.id).expect(429)
            const job = await request(app.getHttpServer()).get(`/v1/jobs/${created.body.job.id}`).set(as(user))

            expect(res.body.errorCode).toBe(RequestErrorCode.QuotaExceeded)
            expect(job.body.job).toMatchObject({ status: JobStatus.Error, errorCode: JobErrorCode.AnalysisFailed })
            expect(await usage('203.0.113.16')).toEqual({ total: 0, anonymous: 0 })
            expect(dispatch).not.toHaveBeenCalled()
        })

        it('gives the network run back when the worker cannot be started', async () => {
            const created = await createFrom(MEMBER, '203.0.113.7').expect(201)

            dispatch.mockRejectedValueOnce(new Error('Cloud Run unavailable'))
            await analyzeFrom(MEMBER, '203.0.113.7', created.body.job.id).expect(503)

            expect(await usage('203.0.113.7')).toEqual({ total: 0, anonymous: 0 })
        })
    })
})
