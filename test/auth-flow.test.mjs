// The email/password flows against the real Better Auth (which Jest can't load as ESM), on the built app with an
// in-memory MongoDB replica set (Better Auth uses transactions). Emails are captured instead of sent; storage is faked.
// Run after a build: npm run test:auth
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, before, test } from 'node:test'

const require = createRequire(import.meta.url)
const PORT = 8123
const API = `http://localhost:${PORT}`
const WEB = 'http://localhost:3000'
const EMAIL = 'flow@example.com'

const outbox = []
const purgedPrefixes = []
let isMailDown = false
let mongo
let app
let session
let freshSession

const headers = (cookie) => ({ 'content-type': 'application/json', origin: WEB, ...(cookie ? { cookie } : {}) })
const cookieOf = (res) =>
    res.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0])
        .join('; ')
const post = (path, body, cookie) =>
    fetch(API + path, { method: 'POST', headers: headers(cookie), body: JSON.stringify(body), redirect: 'manual' })
const linkIn = (message) => new URL(message.text.match(/https?:\/\/\S+/)[0])
const settle = () => new Promise((resolve) => setTimeout(resolve, 300))

before(async () => {
    const { MongoMemoryReplSet } = require('mongodb-memory-server')

    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
    Object.assign(process.env, {
        NODE_ENV: 'test',
        MONGODB_URI: mongo.getUri(),
        GOOGLE_CLOUD_PROJECT: 'test-project',
        STORAGE_BUCKET: 'test-bucket',
        BETTER_AUTH_SECRET: 'auth-flow-test-secret-auth-flow-test-secret',
        BETTER_AUTH_URL: API,
        WEB_ORIGIN: WEB,
    })

    const { Test } = require('@nestjs/testing')
    const { toNodeHandler } = require('better-auth/node')
    const { AppModule } = require('../dist/app.module')
    const { AUTH, withOutbox } = require('../dist/auth/auth.instance')
    const { Mailer } = require('../dist/mail/mailer')
    const { JobEventsService } = require('../dist/realtime/job-events.service')
    const { StorageService } = require('../dist/storage/storage.service')
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(Mailer)
        .useValue({
            send: async (message) => {
                if (isMailDown) {
                    throw new Error('Resend is down')
                }

                outbox.push(message)
            },
        })
        .overrideProvider(StorageService)
        .useValue({ bucketName: 'test-bucket', deletePrefix: async (prefix) => purgedPrefixes.push(prefix) })
        .overrideProvider(JobEventsService)
        .useValue({ onModuleInit: () => undefined, onModuleDestroy: () => undefined })
        .compile()

    app = moduleRef.createNestApplication({ bodyParser: false, logger: false })
    app.enableCors({ origin: WEB, credentials: true })
    const authHandler = toNodeHandler(app.get(AUTH))
    app.getHttpAdapter()
        .getInstance()
        .all('/api/auth/*splat', (req, res) => withOutbox(() => authHandler(req, res)))
    app.useBodyParser('json')
    await app.listen(PORT)
})

after(async () => {
    await app?.close()
    await mongo?.stop()
})

test('sign-up sends a verification email and creates no session yet', async () => {
    const res = await post('/api/auth/sign-up/email', {
        name: 'Flow',
        email: EMAIL,
        password: 'first-password',
    })

    await settle()
    assert.equal(res.status, 200)
    assert.ok(!cookieOf(res).includes('session_token'))
    assert.equal(outbox.length, 1)
})

test('an unverified account cannot sign in', async () => {
    const res = await post('/api/auth/sign-in/email', { email: EMAIL, password: 'first-password' })

    assert.equal(res.status, 403)
})

test('the emailed link opens the web app, which confirms the email and gets an httpOnly SameSite=Lax cookie', async () => {
    const link = linkIn(outbox[0])
    const token = link.searchParams.get('token')
    const res = await fetch(`${API}/api/auth/verify-email?token=${encodeURIComponent(token)}`, { headers: headers() })

    session = cookieOf(res)
    assert.equal(link.origin + link.pathname, `${WEB}/confirm-email`)
    assert.equal(res.status, 200)
    assert.ok(
        res.headers
            .getSetCookie()
            .some((c) => /session_token/.test(c) && /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c)),
    )
})

test('the API accepts the session cookie', async () => {
    const res = await fetch(`${API}/v1/me/quota`, { headers: headers(session) })

    assert.equal(res.status, 200)
})

test('a password reset works through the emailed link and revokes existing sessions', async () => {
    outbox.length = 0

    await post('/api/auth/request-password-reset', { email: EMAIL })
    await settle()

    const link = linkIn(outbox[0])
    const reset = await post('/api/auth/reset-password', {
        newPassword: 'second-password',
        token: link.searchParams.get('token'),
    })
    const withOldSession = await fetch(`${API}/v1/me/quota`, { headers: headers(session) })
    const signIn = await post('/api/auth/sign-in/email', { email: EMAIL, password: 'second-password' })

    freshSession = cookieOf(signIn)
    assert.equal(link.origin + link.pathname, `${WEB}/reset-password`)
    assert.equal(reset.status, 200)
    assert.equal(withOldSession.status, 401)
    assert.equal(signIn.status, 200)
})

test("deleting the account purges the user's stored files and blocks sign-in", async () => {
    const deleted = await post('/api/auth/delete-user', { password: 'second-password' }, freshSession)
    const signIn = await post('/api/auth/sign-in/email', { email: EMAIL, password: 'second-password' })

    assert.equal(deleted.status, 200)
    assert.equal(purgedPrefixes.length, 1)
    assert.match(purgedPrefixes[0], /^users\/[^/]+\/$/)
    assert.equal(signIn.status, 401)
})

test('sign-up fails with EMAIL_NOT_SENT when the verification email cannot be sent', async () => {
    isMailDown = true

    try {
        const res = await post('/api/auth/sign-up/email', {
            name: 'Unlucky',
            email: 'mail-down@example.com',
            password: 'first-password',
        })
        const body = await res.json()

        assert.equal(res.status, 503)
        assert.equal(body.code, 'EMAIL_NOT_SENT')
    } finally {
        isMailDown = false
    }
})

test('a password reset request fails with EMAIL_NOT_SENT when the email cannot be sent', async () => {
    await post('/api/auth/sign-up/email', {
        name: 'Reset',
        email: 'reset-down@example.com',
        password: 'first-password',
    })
    isMailDown = true

    try {
        const res = await post('/api/auth/request-password-reset', { email: 'reset-down@example.com' })
        const body = await res.json()

        assert.equal(res.status, 503)
        assert.equal(body.code, 'EMAIL_NOT_SENT')
    } finally {
        isMailDown = false
    }
})
