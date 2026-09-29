import type { INestApplication } from '@nestjs/common'
import { getConnectionToken, getModelToken } from '@nestjs/mongoose'
import { Test } from '@nestjs/testing'
import { JobErrorCode, JobStatus, RequestErrorCode, VideoMimeType } from 'adlens-shared'
import { type Connection, type Model, Types } from 'mongoose'
import type { IncomingHttpHeaders } from 'node:http'
import request from 'supertest'
import { AnalysisDispatcher } from '../src/analysis/dispatch/analysis-dispatcher'
import { AppModule } from '../src/app.module'
import { AUTH } from '../src/auth/auth.instance'
import { AuthService } from '../src/auth/auth.service'
import { ChallengeVerifier } from '../src/challenge/challenge-verifier'
import { ApiExceptionFilter } from '../src/common/api-exception.filter'
import { CONTACT_MESSAGE_MODEL, type ContactMessageDoc } from '../src/database/contact-message.doc'
import { JOB_MODEL, type JobDoc } from '../src/database/job.doc'
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
const FILE = { name: 'ad.mp4', contentType: VideoMimeType.Mp4, size: 5_000_000 }
const SETTINGS = { platforms: ['Meta'], placements: ['meta_reels'], markets: ['EU'] }

describe('Jobs API (e2e)', () => {
    let app: INestApplication
    let storedObject: ObjectInfo | null
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
                getObjectInfo: async () => storedObject,
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
                [OWNER, STRANGER, SAMPLER, DELETER].map((id) => ({
                    _id: new Types.ObjectId(id),
                    email: `${id}@example.com`,
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

    it('rejects a video over the duration limit without charging', async () => {
        const jobId = await createJob()
        const before = await request(app.getHttpServer()).get('/v1/me/quota').set(as(OWNER))

        probe = { ...probe, durationS: 61 }

        const res = await request(app.getHttpServer()).post(`/v1/jobs/${jobId}/analyze`).set(as(OWNER)).expect(422)
        const after = await request(app.getHttpServer()).get('/v1/me/quota').set(as(OWNER))

        expect(res.body.errorCode).toBe(JobErrorCode.VideoTooLong)
        expect(after.body.quota.used).toBe(before.body.quota.used)
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

    it('pages the job list newest first', async () => {
        const res = await request(app.getHttpServer()).get('/v1/jobs?limit=2').set(as(OWNER)).expect(200)
        const next = await request(app.getHttpServer())
            .get(`/v1/jobs?limit=2&cursor=${res.body.nextCursor}`)
            .set(as(OWNER))
            .expect(200)

        expect(res.body.jobs).toHaveLength(2)
        expect(res.body.nextCursor).toEqual(expect.any(String))
        expect(next.body.jobs[0].id < res.body.jobs[1].id).toBe(true)
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
        const MESSAGE = { email: 'visitor@example.com', message: 'Hello, I would like to know more about AdLens.' }
        let contactMessages: Model<ContactMessageDoc>

        beforeAll(() => {
            contactMessages = app.get(getModelToken(CONTACT_MESSAGE_MODEL))
        })

        beforeEach(async () => {
            await contactMessages.deleteMany({})
        })

        it('emails the message to the team without a session, replying to the sender', async () => {
            await request(app.getHttpServer()).post('/v1/contact').send(MESSAGE).expect(204)

            expect(sendMail).toHaveBeenCalledTimes(1)
            expect(sendMail.mock.calls[0][0]).toMatchObject({ to: 'team@adlens.test', replyTo: MESSAGE.email })
            expect(sendMail.mock.calls[0][0].text).toContain(MESSAGE.message)
        })

        it('escapes the message in the HTML version', async () => {
            await request(app.getHttpServer())
                .post('/v1/contact')
                .send({ ...MESSAGE, message: '<script>alert(1)</script> hello there' })
                .expect(204)

            expect(sendMail.mock.calls[0][0].html).not.toContain('<script>')
        })

        it('accepts but drops a message that filled in the honeypot', async () => {
            await request(app.getHttpServer())
                .post('/v1/contact')
                .send({ ...MESSAGE, website: 'https://spam.example' })
                .expect(204)

            expect(sendMail).not.toHaveBeenCalled()
        })

        it('rejects an invalid message', async () => {
            const res = await request(app.getHttpServer())
                .post('/v1/contact')
                .send({ email: 'nope', message: 'hi' })
                .expect(400)

            expect(res.body.errorCode).toBe(RequestErrorCode.ValidationFailed)
        })

        it('limits how often one sender can write', async () => {
            for (let sent = 0; sent < 3; sent++) {
                await request(app.getHttpServer()).post('/v1/contact').send(MESSAGE).expect(204)
            }

            const res = await request(app.getHttpServer()).post('/v1/contact').send(MESSAGE).expect(429)

            expect(res.body.errorCode).toBe(RequestErrorCode.RateLimited)
            expect(sendMail).toHaveBeenCalledTimes(3)
        })

        it('caps the total number of messages per hour', async () => {
            await contactMessages.insertMany(
                Array.from({ length: 20 }, (_, index) => ({ email: `sender${index}@example.com` })),
            )

            const res = await request(app.getHttpServer()).post('/v1/contact').send(MESSAGE).expect(429)

            expect(res.body.errorCode).toBe(RequestErrorCode.RateLimited)
            expect(sendMail).not.toHaveBeenCalled()
        })
    })

    describe('analysis without an account and the network limits', () => {
        const ANON = new Types.ObjectId().toString()
        const MEMBER = new Types.ObjectId().toString()
        const ADMIN = new Types.ObjectId().toString()
        const LIMITED = new Types.ObjectId().toString()

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

        const seedNetwork = async (network: string, runs: number, isAnonymous = false) => {
            const bucketKey = networkKey(network)

            for (let i = 0; i < runs; i++) {
                await app.get(IpQuotaService).charge({ bucketKey, isAnonymous, hasPassedChallenge: true }, `seed-${i}`)
            }
        }

        beforeAll(async () => {
            await app
                .get<Connection>(getConnectionToken())
                .collection(USER_COLLECTION)
                .insertMany([
                    {
                        _id: new Types.ObjectId(ANON),
                        email: `${ANON}@anonymous.placeholder.invalid`,
                        isAnonymous: true,
                    },
                    { _id: new Types.ObjectId(MEMBER), email: 'member@example.com' },
                    { _id: new Types.ObjectId(ADMIN), email: 'admin@example.com', isAdmin: true },
                    {
                        _id: new Types.ObjectId(LIMITED),
                        email: 'limited@example.com',
                        runs: [0, 1, 2].map((i) => ({ id: `run-${i}`, startedAt: new Date(), jobId: `job-${i}` })),
                    },
                ])
        })

        it('lets an anonymous user analyze once the challenge passes, checking it with their address', async () => {
            const created = await createFrom(ANON, '203.0.113.1', { challengeToken: 'pass' }).expect(201)

            await analyzeFrom(ANON, '203.0.113.1', created.body.job.id).expect(202)

            expect(verifyChallenge).toHaveBeenCalledWith('pass', '203.0.113.1')
            expect(await usage('203.0.113.1')).toEqual({ total: 1, anonymous: 1 })
        })

        it('asks an anonymous user for the challenge and refuses a failed one', async () => {
            const missing = await createFrom(ANON, '203.0.113.2').expect(403)
            const failed = await createFrom(ANON, '203.0.113.2', { challengeToken: 'fail' }).expect(403)

            expect(missing.body.errorCode).toBe(RequestErrorCode.ChallengeRequired)
            expect(failed.body.errorCode).toBe(RequestErrorCode.ChallengeFailed)
        })

        it('checks a sample job before looking the sample up', async () => {
            const res = await request(app.getHttpServer())
                .post('/v1/jobs/from-sample')
                .set({ ...as(ANON), ...from('203.0.113.2') })
                .send({ sampleId: '64b000000000000000000000', settings: SETTINGS })
                .expect(403)

            expect(res.body.errorCode).toBe(RequestErrorCode.ChallengeRequired)
        })

        it('asks for sign-up once the network used its anonymous analyses, but lets members in', async () => {
            await seedNetwork('203.0.113.3', 3, true)

            const anonymous = await createFrom(ANON, '203.0.113.3', { challengeToken: 'pass' }).expect(429)

            await createFrom(MEMBER, '203.0.113.3').expect(201)
            expect(anonymous.body.errorCode).toBe(RequestErrorCode.SignUpRequired)
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
