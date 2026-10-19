import type { INestApplication } from '@nestjs/common'
import { getConnectionToken } from '@nestjs/mongoose'
import { Test } from '@nestjs/testing'
import { type AdminJob, type AdminUser, JobStatus } from 'adlens-shared'
import { type Connection, Types } from 'mongoose'
import type { IncomingHttpHeaders } from 'node:http'
import request from 'supertest'
import { AnalysisDispatcher } from '../src/analysis/dispatch/analysis-dispatcher'
import { AppModule } from '../src/app.module'
import { AUTH } from '../src/auth/auth.instance'
import { AuthService } from '../src/auth/auth.service'
import { ChallengeVerifier } from '../src/challenge/challenge-verifier'
import { ApiExceptionFilter } from '../src/common/api-exception.filter'
import { JOB_COLLECTION } from '../src/database/job.doc'
import { SAMPLE_COLLECTION } from '../src/database/sample.doc'
import { USER_COLLECTION } from '../src/database/user.doc'
import { MediaProber } from '../src/jobs/verification/media-prober'
import { LivePublisher } from '../src/live/live-publisher'
import { Mailer } from '../src/mail/mailer'
import { StorageService } from '../src/storage/storage.service'
import { RecordingLivePublisher } from '../src/testing/recording-live-publisher'

const ADMIN_PATHS = ['/v1/admin/jobs', '/v1/admin/users']
const UNKNOWN_PATH = '/v1/admin/nonexistent'

const ADMIN = new Types.ObjectId()
const MEMBER = new Types.ObjectId()
const UNCONFIRMED = new Types.ObjectId()
const ANONYMOUS = new Types.ObjectId()
// A session whose user document is gone.
const UNKNOWN = new Types.ObjectId()

const SAMPLE = new Types.ObjectId()
// Created in this order, so the sample job is the newer one.
const CALLS_JOB = new Types.ObjectId()
const SAMPLE_JOB = new Types.ObjectId()

const CALL = {
    at: new Date('2026-09-30T10:01:00.000Z'),
    model: 'gemini-3.6-flash',
    location: 'global',
    promptTokens: 8447,
    candidatesTokens: 127,
    thoughtsTokens: 965,
    cachedTokens: 4000,
    promptTokensByModality: { AUDIO: 750, VIDEO: 1980, TEXT: 5717 },
    cachedTokensByModality: { TEXT: 4000 },
    durationMs: 22040,
    trafficType: 'ON_DEMAND_FLEX',
}

// Server-only fields the stored job has and the admin routes must not return.
const STORED_ONLY = { toolUsePromptTokens: 0, totalTokens: 9539, finishReason: 'STOP' }

// The e2e suites share one database, whose `user` collection has a unique email index.
const emailOf = (userId: Types.ObjectId) => `${userId.toString()}@example.com`

const as = (userId: Types.ObjectId) => ({ 'x-test-user': userId.toString() })

const storedJob = (_id: Types.ObjectId, fields: Record<string, unknown>) => ({
    _id,
    createdAt: _id.getTimestamp(),
    status: JobStatus.Analyzed,
    userId: MEMBER.toString(),
    file: { name: `${_id.toString()}.mp4`, bucket: 'test-bucket', path: `uploads/${_id.toString()}.mp4` },
    chargedRunId: null,
    chargedIpRunId: null,
    ...fields,
})

describe('Admin API (e2e)', () => {
    let app: INestApplication
    let users: ReturnType<Connection['collection']>

    const get = (path: string, userId?: Types.ObjectId) => {
        const req = request(app.getHttpServer()).get(path)

        return userId ? req.set(as(userId)) : req
    }

    // Status and body must match what Nest answers for a route that doesn't exist, so a probe can't tell the admin
    // routes exist; only the path in the message differs.
    const expectLikeUnknownRoute = async (res: request.Response, path: string) => {
        const unknown = await get(UNKNOWN_PATH)

        expect(unknown.status).toBe(404)
        expect(res.status).toBe(unknown.status)
        expect(res.headers['content-type']).toBe(unknown.headers['content-type'])
        expect(res.headers['cache-control']).toBe(unknown.headers['cache-control'])
        expect(res.text).toBe(unknown.text.replace(UNKNOWN_PATH, path))
    }

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(AUTH)
            .useValue({})
            .overrideProvider(AuthService)
            .useValue({ getUserId: async (headers: IncomingHttpHeaders) => headers['x-test-user'] ?? null })
            .overrideProvider(StorageService)
            .useValue({ bucketName: 'test-bucket' })
            .overrideProvider(MediaProber)
            .useValue({})
            .overrideProvider(AnalysisDispatcher)
            .useValue({ dispatch: async () => 'executions/exec-1' })
            .overrideProvider(Mailer)
            .useValue({ send: async () => undefined })
            .overrideProvider(ChallengeVerifier)
            .useValue({ verify: async () => true })
            .overrideProvider(LivePublisher)
            .useValue(new RecordingLivePublisher())
            .compile()

        app = moduleRef.createNestApplication()
        app.useGlobalFilters(new ApiExceptionFilter())
        await app.listen(0)

        const connection = app.get<Connection>(getConnectionToken())

        users = connection.collection(USER_COLLECTION)
        await users.insertMany([
            { _id: ADMIN, email: emailOf(ADMIN), emailVerified: true, isAdmin: true },
            { _id: MEMBER, email: emailOf(MEMBER), emailVerified: true },
            { _id: UNCONFIRMED, email: emailOf(UNCONFIRMED), emailVerified: false },
            {
                _id: ANONYMOUS,
                email: `${ANONYMOUS.toString()}@anonymous.placeholder.invalid`,
                emailVerified: false,
                isAnonymous: true,
            },
        ])
        await connection.collection(SAMPLE_COLLECTION).insertOne({ _id: SAMPLE, title: 'Energy drink' })
        await connection
            .collection(JOB_COLLECTION)
            .insertMany([
                storedJob(CALLS_JOB, { usage: { promptTokens: 8447, calls: [{ ...CALL, ...STORED_ONLY }] } }),
                storedJob(SAMPLE_JOB, { sampleId: SAMPLE.toString() }),
            ])
    })

    afterAll(async () => {
        await app.close()
    })

    describe.each(ADMIN_PATHS)('GET %s', (path) => {
        it('answers like an unknown route without a session', async () => {
            const res = await get(path)

            await expectLikeUnknownRoute(res, path)
        })

        it.each([
            ['an anonymous user', ANONYMOUS],
            ['an unconfirmed account', UNCONFIRMED],
            ['a member', MEMBER],
            ['a user whose document is gone', UNKNOWN],
        ])('answers like an unknown route for %s', async (_label, userId) => {
            const res = await get(path, userId)

            await expectLikeUnknownRoute(res, path)
        })

        it('keeps the query string in the message, as Nest does', async () => {
            const res = await get(`${path}?limit=1`, MEMBER)

            await expectLikeUnknownRoute(res, `${path}?limit=1`)
        })
    })

    it('lists every job for an admin, newest first, with its sample title and calls', async () => {
        const res = await get('/v1/admin/jobs', ADMIN).expect(200)
        const jobs: AdminJob[] = res.body.jobs
        const ids = jobs.map((job) => job.id)
        const callsJob = jobs.find((job) => job.id === CALLS_JOB.toString())
        const sampleJob = jobs.find((job) => job.id === SAMPLE_JOB.toString())

        expect(ids).toEqual([...ids].sort().reverse())
        expect(ids.indexOf(SAMPLE_JOB.toString())).toBeLessThan(ids.indexOf(CALLS_JOB.toString()))
        expect(sampleJob).toEqual({
            id: SAMPLE_JOB.toString(),
            createdAt: SAMPLE_JOB.getTimestamp().toISOString(),
            status: JobStatus.Analyzed,
            userId: MEMBER.toString(),
            file: { name: `${SAMPLE_JOB.toString()}.mp4` },
            sampleId: SAMPLE.toString(),
            sampleTitle: 'Energy drink',
        })
        expect(callsJob?.file).toEqual({ name: `${CALLS_JOB.toString()}.mp4` })
        expect(callsJob?.usage?.calls).toEqual([{ ...CALL, at: '2026-09-30T10:01:00.000Z' }])
        expect(res.headers['cache-control']).toBe('no-store')
    })

    it('lists every user for an admin, an anonymous one without its placeholder email', async () => {
        const res = await get('/v1/admin/users', ADMIN).expect(200)
        const listed: AdminUser[] = res.body.users

        expect(listed.find((user) => user.id === ANONYMOUS.toString())).toEqual({
            id: ANONYMOUS.toString(),
            createdAt: ANONYMOUS.getTimestamp().toISOString(),
            email: null,
            isAnonymous: true,
            emailVerified: false,
            isAdmin: false,
        })
        expect(listed.find((user) => user.id === ADMIN.toString())).toMatchObject({
            email: emailOf(ADMIN),
            isAdmin: true,
        })
        expect(listed.map((user) => user.id)).toEqual(expect.arrayContaining([MEMBER.toString()]))
        expect(res.headers['cache-control']).toBe('no-store')
    })

    it('reads admin status on every request, so an admin who loses it gets an unknown route next', async () => {
        const demoted = new Types.ObjectId()

        await users.insertOne({ _id: demoted, email: emailOf(demoted), emailVerified: true, isAdmin: true })
        await get('/v1/admin/jobs', demoted).expect(200)
        await users.updateOne({ _id: demoted }, { $set: { isAdmin: false } })

        const res = await get('/v1/admin/jobs', demoted)

        await expectLikeUnknownRoute(res, '/v1/admin/jobs')
    })
})
