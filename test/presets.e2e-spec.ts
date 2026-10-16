import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import {
    type AnalysisSettings,
    getLiveChannel,
    LiveEvent,
    Market,
    MAX_PRESETS,
    Placement,
    Platform,
    type Preset,
    RequestErrorCode,
    type SavePresetInput,
} from 'adlens-shared'
import { Types } from 'mongoose'
import type { IncomingHttpHeaders } from 'node:http'
import request from 'supertest'
import { AnalysisDispatcher } from '../src/analysis/dispatch/analysis-dispatcher'
import { AppModule } from '../src/app.module'
import { AUTH } from '../src/auth/auth.instance'
import { AuthService } from '../src/auth/auth.service'
import { ChallengeVerifier } from '../src/challenge/challenge-verifier'
import { ApiExceptionFilter } from '../src/common/api-exception.filter'
import { MediaProber } from '../src/jobs/verification/media-prober'
import { LivePublisher } from '../src/live/live-publisher'
import { Mailer } from '../src/mail/mailer'
import { StorageService } from '../src/storage/storage.service'
import { RecordingLivePublisher } from '../src/testing/recording-live-publisher'

const SETTINGS: AnalysisSettings = {
    platforms: [Platform.Meta],
    placements: [Placement.MetaFeed],
    markets: [Market.US],
}

const OTHER_SETTINGS: AnalysisSettings = {
    platforms: [Platform.TikTok],
    placements: [Placement.TikTokInFeed],
    markets: [Market.EU],
}

describe('Presets API (e2e)', () => {
    let app: INestApplication
    // A new user per test, so no test sees another's presets.
    let owner: string
    const live = new RecordingLivePublisher()

    const as = (userId: string) => ({ 'x-test-user': userId })
    const input = (name: string, fields: Partial<SavePresetInput> = {}): SavePresetInput => ({
        name,
        settings: SETTINGS,
        ...fields,
    })

    const save = (name: string, fields: Partial<SavePresetInput> = {}, userId = owner) =>
        request(app.getHttpServer()).post('/v1/presets').set(as(userId)).send(input(name, fields))

    const create = async (name: string, fields: Partial<SavePresetInput> = {}): Promise<Preset> => {
        const res = await save(name, fields).expect(201)

        return res.body.preset
    }

    const list = async (userId = owner): Promise<Preset[]> => {
        const res = await request(app.getHttpServer()).get('/v1/presets').set(as(userId)).expect(200)

        return res.body.presets
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
            .useValue(live)
            .compile()

        app = moduleRef.createNestApplication()
        app.useGlobalFilters(new ApiExceptionFilter())
        await app.listen(0)
    })

    beforeEach(() => {
        owner = new Types.ObjectId().toString()
        live.clear()
    })

    afterAll(async () => {
        await app.close()
    })

    it('requires a session', async () => {
        const res = await request(app.getHttpServer()).get('/v1/presets').expect(401)

        expect(res.body.errorCode).toBe(RequestErrorCode.Unauthenticated)
    })

    it("tells the owner's tabs that their presets changed", async () => {
        await create('Meta US')

        expect(live.events).toEqual([{ channel: getLiveChannel(owner), event: LiveEvent.Presets }])
    })

    it("answers a live token for the session user's own channel only", async () => {
        const res = await request(app.getHttpServer()).get('/v1/live/token').set(as(owner)).expect(200)

        expect(JSON.parse(res.body.tokenRequest.capability)).toEqual({ [getLiveChannel(owner)]: ['subscribe'] })
    })

    it('requires a session for a live token', async () => {
        const res = await request(app.getHttpServer()).get('/v1/live/token').expect(401)

        expect(res.body.errorCode).toBe(RequestErrorCode.Unauthenticated)
    })

    it('lists no presets for a new user', async () => {
        const res = await request(app.getHttpServer()).get('/v1/presets').set(as(owner)).expect(200)

        expect(res.body).toEqual({ presets: [] })
    })

    it('creates a preset with 201 and lists it', async () => {
        const res = await save('Reels EU').expect(201)

        expect(res.body.preset).toMatchObject({ name: 'Reels EU', settings: SETTINGS, isDefault: false, usageCount: 0 })
        expect(await list()).toEqual([res.body.preset])
    })

    it('refuses a taken name with PRESET_NAME_TAKEN', async () => {
        await create('Reels EU')

        const res = await save('reels eu').expect(409)

        expect(res.body.errorCode).toBe(RequestErrorCode.PresetNameTaken)
    })

    it('overwrites a taken name with 200 when asked to', async () => {
        const created = await create('Reels EU')

        const res = await save('Reels EU', { settings: OTHER_SETTINGS, overwrite: true }).expect(200)

        expect(res.body.preset).toMatchObject({ id: created.id, settings: OTHER_SETTINGS })
        expect(await list()).toHaveLength(1)
    })

    it('refuses a new name past the limit with PRESET_LIMIT_REACHED', async () => {
        for (let i = 0; i < MAX_PRESETS; i++) {
            await create(`Preset ${i}`)
        }

        const res = await save('One too many').expect(409)

        expect(res.body.errorCode).toBe(RequestErrorCode.PresetLimitReached)
    })

    it.each([
        ['an empty name', { name: '', settings: SETTINGS }],
        ['an unknown key', { name: 'Reels', settings: SETTINGS, userId: 'someone' }],
    ])('rejects %s with VALIDATION_FAILED', async (_label, body) => {
        const res = await request(app.getHttpServer()).post('/v1/presets').set(as(owner)).send(body).expect(400)

        expect(res.body.errorCode).toBe(RequestErrorCode.ValidationFailed)
        expect(res.body.issues.length).toBeGreaterThan(0)
    })

    it('updates a preset', async () => {
        const created = await create('Reels EU')

        const res = await request(app.getHttpServer())
            .put(`/v1/presets/${created.id}`)
            .set(as(owner))
            .send(input('Renamed', { settings: OTHER_SETTINGS }))
            .expect(200)

        expect(res.body.preset).toMatchObject({ id: created.id, name: 'Renamed', settings: OTHER_SETTINGS })
    })

    it('answers NOT_FOUND when updating an unknown preset', async () => {
        const res = await request(app.getHttpServer())
            .put(`/v1/presets/${new Types.ObjectId().toString()}`)
            .set(as(owner))
            .send(input('Reels EU'))
            .expect(404)

        expect(res.body.errorCode).toBe(RequestErrorCode.NotFound)
    })

    it('sets and clears the default preset', async () => {
        const created = await create('Reels EU')

        await request(app.getHttpServer())
            .put('/v1/presets/default')
            .set(as(owner))
            .send({ presetId: created.id })
            .expect(204)

        expect((await list())[0].isDefault).toBe(true)

        await request(app.getHttpServer())
            .put('/v1/presets/default')
            .set(as(owner))
            .send({ presetId: null })
            .expect(204)

        expect((await list())[0].isDefault).toBe(false)
    })

    it('answers NOT_FOUND when making an unknown preset the default', async () => {
        const res = await request(app.getHttpServer())
            .put('/v1/presets/default')
            .set(as(owner))
            .send({ presetId: new Types.ObjectId().toString() })
            .expect(404)

        expect(res.body.errorCode).toBe(RequestErrorCode.NotFound)
    })

    it('refuses a user’s writes past 60 a minute with RATE_LIMITED, leaving other users alone', async () => {
        const clearDefault = (userId = owner) =>
            request(app.getHttpServer()).put('/v1/presets/default').set(as(userId)).send({ presetId: null })

        for (let index = 0; index < 60; index++) {
            await clearDefault().expect(204)
        }

        const refused = await clearDefault().expect(429)

        expect(refused.body.errorCode).toBe(RequestErrorCode.RateLimited)
        await clearDefault(new Types.ObjectId().toString()).expect(204)
    })

    it('deletes a preset, then answers NOT_FOUND for it', async () => {
        const created = await create('Reels EU')

        await request(app.getHttpServer()).delete(`/v1/presets/${created.id}`).set(as(owner)).expect(204)

        const again = await request(app.getHttpServer()).delete(`/v1/presets/${created.id}`).set(as(owner)).expect(404)

        expect(again.body.errorCode).toBe(RequestErrorCode.NotFound)
        expect(await list()).toEqual([])
    })

    it("hides one user's presets from another", async () => {
        const stranger = new Types.ObjectId().toString()
        const created = await create('Reels EU')

        const update = await request(app.getHttpServer())
            .put(`/v1/presets/${created.id}`)
            .set(as(stranger))
            .send(input('Taken over'))
            .expect(404)
        const remove = await request(app.getHttpServer())
            .delete(`/v1/presets/${created.id}`)
            .set(as(stranger))
            .expect(404)
        const makeDefault = await request(app.getHttpServer())
            .put('/v1/presets/default')
            .set(as(stranger))
            .send({ presetId: created.id })
            .expect(404)

        expect(update.body.errorCode).toBe(RequestErrorCode.NotFound)
        expect(remove.body.errorCode).toBe(RequestErrorCode.NotFound)
        expect(makeDefault.body.errorCode).toBe(RequestErrorCode.NotFound)
        expect(await list(stranger)).toEqual([])
        expect(await list()).toEqual([created])
    })
})
