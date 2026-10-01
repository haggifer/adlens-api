import type { INestApplication } from '@nestjs/common'
import { getConnectionToken, getModelToken } from '@nestjs/mongoose'
import { Test } from '@nestjs/testing'
import { JobErrorCode, JobStatus, MAX_DURATION_S, RequestErrorCode, VideoMimeType } from 'adlens-shared'
import { type Connection, type Model, Types } from 'mongoose'
import type { IncomingHttpHeaders } from 'node:http'
import request from 'supertest'
import { AnalysisDispatcher } from '../src/analysis/dispatch/analysis-dispatcher'
import { AppModule } from '../src/app.module'
import { AUTH_INDEXES } from '../src/auth/auth-indexes'
import { AUTH } from '../src/auth/auth.instance'
import { AuthService } from '../src/auth/auth.service'
import { ChallengeVerifier } from '../src/challenge/challenge-verifier'
import { ApiExceptionFilter } from '../src/common/api-exception.filter'
import { UserAccess } from '../src/common/user-access'
import { JOB_MODEL, type JobDoc } from '../src/database/job.doc'
import { RATE_LIMIT_COLLECTION } from '../src/database/rate-limit.doc'
import { SAMPLE_MODEL, type SampleDoc } from '../src/database/sample.doc'
import { USER_COLLECTION } from '../src/database/user.doc'
import { ClientNetworkResolver } from '../src/ip-quota/client-network.resolver'
import { IpQuotaService } from '../src/ip-quota/ip-quota.service'
import { MediaProber, type ProbeResult } from '../src/jobs/verification/media-prober'
import { Mailer, type MailMessage } from '../src/mail/mailer'
import { JobEventsService } from '../src/realtime/job-events.service'
import { type ObjectInfo, StorageService } from '../src/storage/storage.service'

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
    const dispatch = jest.fn(async () => 'executions/exec-1')
    const deleteObject = jest.fn(async (_path: string) => undefined)
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
            })
            .overrideProvider(MediaProber)
            .useValue({ probe: async () => probe })
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
        await app.init()

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

    it('keeps the job pending when the upload has not arrived', async () => {
        const jobId = await createJob()

        storedObject = null

        const res = await request(app.getHttpServer()).post(`/v1/jobs/${jobId}/analyze`).set(as(OWNER)).expect(409)
        const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set(as(OWNER)).expect(200)

        expect(res.body.errorCode).toBe(RequestErrorCode.UploadIncomplete)
        expect(job.body.job.status).toBe(JobStatus.Pending)
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

    it('keeps the job pending and the upload in place when storage cannot be reached', async () => {
        const jobId = await createJob()

        storedObject = new Error('GCS 503')

        const res = await request(app.getHttpServer()).post(`/v1/jobs/${jobId}/analyze`).set(as(OWNER)).expect(503)
        const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set(as(OWNER))

        expect(res.body.errorCode).toBe(RequestErrorCode.Unavailable)
        expect(job.body.job.status).toBe(JobStatus.Pending)
        expect(deleteObject).not.toHaveBeenCalled()
    })

    it('refunds and reopens the job when the worker cannot be started', async () => {
        const jobId = await createJob()
        const before = await request(app.getHttpServer()).get('/v1/me/quota').set(as(OWNER))

        dispatch.mockRejectedValueOnce(new Error('Cloud Run unavailable'))

        const res = await request(app.getHttpServer()).post(`/v1/jobs/${jobId}/analyze`).set(as(OWNER)).expect(503)
        const after = await request(app.getHttpServer()).get('/v1/me/quota').set(as(OWNER))
        const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set(as(OWNER))

        expect(res.body.errorCode).toBe(RequestErrorCode.Unavailable)
        expect(after.body.quota.used).toBe(before.body.quota.used)
        expect(job.body.job.status).toBe(JobStatus.Pending)
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

        it('keeps a sample job pending when its sample has been removed', async () => {
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
            expect(job.body.job.status).toBe(JobStatus.Pending)
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

    describe('contact messages', () => {
        const MESSAGE = {
            email: 'visitor@example.com',
            message: 'Hello, I would like to know more about AdLens.',
            challengeToken: 'pass',
        }
        let networks = 0

        // A network of its own per call unless one is given, so only the cap under test is reached.
        const sendContact = (body: Record<string, unknown>, network = `203.0.113.${++networks}`) =>
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

            expect(next.body.errorCode).toBe(RequestErrorCode.SignUpRequired)
            expect(quota.body.quota).toMatchObject({ used: 1, limit: 1 })
        })

        it('gives an unconfirmed account one analysis, then asks it to confirm its email', async () => {
            const unconfirmed = await addUnconfirmed()
            const created = await createFrom(unconfirmed, '203.0.113.14', { challengeToken: 'pass' }).expect(201)

            await analyzeFrom(unconfirmed, '203.0.113.14', created.body.job.id).expect(202)

            const next = await createFrom(unconfirmed, '203.0.113.15', { challengeToken: 'pass' }).expect(429)
            const quota = await request(app.getHttpServer()).get('/v1/me/quota').set(as(unconfirmed)).expect(200)

            expect(next.body.errorCode).toBe(RequestErrorCode.EmailConfirmationRequired)
            expect(quota.body.quota).toMatchObject({ used: 1, limit: 1 })
        })

        it('refuses a new job once the user has no analyses left', async () => {
            const res = await createFrom(LIMITED, '203.0.113.6').expect(429)

            expect(res.body.errorCode).toBe(RequestErrorCode.QuotaExceeded)
        })

        it('gives the network run back when the worker cannot be started', async () => {
            const created = await createFrom(MEMBER, '203.0.113.7').expect(201)

            dispatch.mockRejectedValueOnce(new Error('Cloud Run unavailable'))
            await analyzeFrom(MEMBER, '203.0.113.7', created.body.job.id).expect(503)

            expect(await usage('203.0.113.7')).toEqual({ total: 0, anonymous: 0 })
        })
    })
})
