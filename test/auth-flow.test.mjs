// The email/password and anonymous flows against the real Better Auth (which Jest can't load as ESM), on the built
// app with an in-memory MongoDB replica set (Better Auth uses transactions). Emails are captured instead of sent;
// storage is faked. Run after a build: npm run test:auth
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
const deletedPaths = []
let adoptedUpload
let linkerSession
let isMailDown = false
let isAdoptDown = false
let mongo
let app
let auth
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
const lastMailTo = (email) => outbox.findLast((message) => message.to === email)
const run = (id) => ({ id, startedAt: new Date(), jobId: `job-${id}` })

const withDb = async (use) => {
    const { MongoClient } = require('mongodb')
    const client = await MongoClient.connect(mongo.getUri())

    try {
        return await use(client.db())
    } finally {
        await client.close()
    }
}

const storedJob = (userId, path) => ({
    userId,
    status: 'analyzed',
    settings: { platforms: [], placements: [], markets: [] },
    file: { name: 'ad.mp4', contentType: 'video/mp4', size: 1000, bucket: 'test-bucket', path },
    chargedRunId: null,
    attempts: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
})

const signInAnonymously = async () => {
    const res = await post('/api/auth/sign-in/anonymous', {})
    const body = await res.json()

    return { status: res.status, cookie: cookieOf(res), user: body.user }
}

const confirmEmail = (email, cookie) => {
    const token = linkIn(lastMailTo(email)).searchParams.get('token')

    return fetch(`${API}/api/auth/verify-email?token=${encodeURIComponent(token)}`, { headers: headers(cookie) })
}

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
        GOOGLE_CLIENT_ID: 'test-google-client-id',
        GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
        GITHUB_CLIENT_ID: 'test-github-client-id',
        GITHUB_CLIENT_SECRET: 'test-github-client-secret',
    })

    const { Test } = require('@nestjs/testing')
    const { toNodeHandler } = require('better-auth/node')
    const { AppModule } = require('../dist/app.module')
    const { AccountDataService } = require('../dist/account/account-data.service')
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
        .useValue({
            bucketName: 'test-bucket',
            delete: async (path) => deletedPaths.push(path),
            deletePrefix: async (prefix) => purgedPrefixes.push(prefix),
        })
        .overrideProvider(JobEventsService)
        .useValue({ onModuleInit: () => undefined, onModuleDestroy: () => undefined })
        .compile()

    app = moduleRef.createNestApplication({ bodyParser: false, logger: false })
    app.enableCors({ origin: WEB, credentials: true })
    auth = app.get(AUTH)

    // Lets a test simulate adopt failing (e.g. a transient DB error) without a second, unwired instance: the real
    // service still runs otherwise, so the legitimate linking tests exercise the real move.
    const accountData = app.get(AccountDataService)
    const adopt = accountData.adopt.bind(accountData)

    accountData.adopt = (anonymousUserId, userId) => {
        if (isAdoptDown) {
            return Promise.reject(new Error('adopt is down'))
        }

        return adopt(anonymousUserId, userId)
    }

    const authHandler = toNodeHandler(auth)
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

test("update-user can't set isAdmin or grant quota runs", async () => {
    // isAdmin is declared with `input: false`, so Better Auth rejects the whole request (400
    // FIELD_NOT_ALLOWED) rather than silently dropping it; `runs` isn't a Better Auth field at all,
    // so it's never written either way. The name change in the same body is proof the write didn't
    // partially apply.
    const { MongoClient } = require('mongodb')

    const res = await post(
        '/api/auth/update-user',
        { name: 'Flow Updated', isAdmin: true, runs: [{ id: 'x', startedAt: new Date().toISOString(), jobId: 'x' }] },
        freshSession,
    )
    const body = await res.json()

    const client = await MongoClient.connect(mongo.getUri())

    try {
        const user = await client.db().collection('user').findOne({ email: EMAIL })

        assert.equal(res.status, 400)
        assert.equal(body.code, 'FIELD_NOT_ALLOWED')
        assert.notEqual(user?.name, 'Flow Updated')
        assert.notEqual(user?.isAdmin, true)
        assert.equal(user?.runs, undefined)
    } finally {
        await client.close()
    }
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

test('no one can make themselves an admin at sign-up', async () => {
    const { MongoClient } = require('mongodb')
    const email = 'wannabe-admin@example.com'

    await post('/api/auth/sign-up/email', { name: 'Wannabe', email, password: 'first-password', isAdmin: true })

    const client = await MongoClient.connect(mongo.getUri())

    try {
        const user = await client.db().collection('user').findOne({ email })

        assert.notEqual(user?.isAdmin, true)
    } finally {
        await client.close()
    }
})

const startSocialSignIn = async (provider, callbackURL) => {
    const res = await post('/api/auth/sign-in/social', { provider, callbackURL })
    const body = await res.json()

    return { status: res.status, body }
}

test('Google sign-in starts at Google, with the account picker and the API as the callback', async () => {
    const { status, body } = await startSocialSignIn('google', `${WEB}/history`)
    const target = new URL(body.url)

    assert.equal(status, 200)
    assert.equal(target.host, 'accounts.google.com')
    assert.equal(target.searchParams.get('client_id'), 'test-google-client-id')
    assert.equal(target.searchParams.get('redirect_uri'), `${API}/api/auth/callback/google`)
    assert.equal(target.searchParams.get('prompt'), 'select_account')
})

test('GitHub sign-in starts at GitHub, asking for the email address, with the API as the callback', async () => {
    const { status, body } = await startSocialSignIn('github', `${WEB}/history`)
    const target = new URL(body.url)

    assert.equal(status, 200)
    assert.equal(target.host, 'github.com')
    assert.equal(target.searchParams.get('client_id'), 'test-github-client-id')
    assert.equal(target.searchParams.get('redirect_uri'), `${API}/api/auth/callback/github`)
    assert.ok(target.searchParams.get('scope').split(' ').includes('user:email'))
})

test('social sign-in refuses to return to a site other than the web app', async () => {
    const { status, body } = await startSocialSignIn('google', 'https://attacker.example/landing')

    assert.equal(status, 403)
    assert.equal(body.url, undefined)
})

test("a Google or GitHub account is stored without the provider's tokens", async () => {
    const { MongoClient } = require('mongodb')
    const context = await auth.$context
    const user = await context.internalAdapter.createUser({
        email: 'tokens@example.com',
        name: 'T',
        emailVerified: true,
    })

    await context.internalAdapter.linkAccount({
        userId: user.id,
        providerId: 'google',
        accountId: 'google-account-1',
        accessToken: 'provider-access-token',
        refreshToken: 'provider-refresh-token',
        idToken: 'provider-id-token',
        accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
    })

    const client = await MongoClient.connect(mongo.getUri())
    const stored = await client.db().collection('account').findOne({ accountId: 'google-account-1' })

    await client.close()
    assert.equal(stored.providerId, 'google')
    assert.equal(stored.accessToken ?? null, null)
    assert.equal(stored.refreshToken ?? null, null)
    assert.equal(stored.idToken ?? null, null)
    assert.equal(stored.accessTokenExpiresAt ?? null, null)
})

test('an anonymous sign-in gets a session for a user with a placeholder address, and no email', async () => {
    const { ObjectId } = require('mongodb')
    const sentBefore = outbox.length
    const anonymous = await signInAnonymously()
    const quota = await fetch(`${API}/v1/me/quota`, { headers: headers(anonymous.cookie) })
    const user = await withDb((db) => db.collection('user').findOne({ _id: new ObjectId(anonymous.user.id) }))

    assert.equal(anonymous.status, 200)
    assert.ok(anonymous.cookie.includes('session_token'))
    assert.match(user.email, /@anonymous\.placeholder\.invalid$/)
    assert.equal(user.isAnonymous, true)
    assert.equal(quota.status, 200)
    assert.equal(outbox.length, sentBefore)
})

test('an anonymous user never gets email, even when asking for a confirmation link', async () => {
    const anonymous = await signInAnonymously()
    const sentBefore = outbox.length
    const res = await post('/api/auth/send-verification-email', { email: anonymous.user.email }, anonymous.cookie)

    await settle()
    assert.equal(res.status, 200)
    assert.equal(outbox.length, sentBefore)
})

test("an anonymous user can't be deleted around the account purge", async () => {
    const { ObjectId } = require('mongodb')
    const anonymous = await signInAnonymously()
    const res = await post('/api/auth/delete-anonymous-user', {}, anonymous.cookie)

    assert.equal(res.status, 404)
    assert.ok(await withDb((db) => db.collection('user').findOne({ _id: new ObjectId(anonymous.user.id) })))
})

test('sign-up refuses a disposable email address', async () => {
    const sentBefore = outbox.length
    const res = await post('/api/auth/sign-up/email', {
        name: 'Throwaway',
        email: 'someone@mailinator.com',
        password: 'first-password',
    })
    const body = await res.json()
    const user = await withDb((db) => db.collection('user').findOne({ email: 'someone@mailinator.com' }))

    assert.equal(res.status, 400)
    assert.equal(body.code, 'DISPOSABLE_EMAIL')
    assert.equal(user, null)
    assert.equal(outbox.length, sentBefore)
})

test('confirming a sign-up in the same browser moves the anonymous history to the new account', async () => {
    const { ObjectId } = require('mongodb')
    const email = 'linker@example.com'
    const anonymous = await signInAnonymously()

    adoptedUpload = `users/${anonymous.user.id}/jobs/linked/video`
    await withDb(async (db) => {
        await db.collection('jobs').insertOne(storedJob(anonymous.user.id, adoptedUpload))
        await db
            .collection('user')
            .updateOne({ _id: new ObjectId(anonymous.user.id) }, { $set: { runs: [run('anonymous-run')] } })
    })

    const purgedBefore = purgedPrefixes.length
    const signUp = await post(
        '/api/auth/sign-up/email',
        { name: 'Linker', email, password: 'first-password' },
        anonymous.cookie,
    )

    await settle()

    const beforeConfirming = await withDb((db) =>
        db.collection('user').findOne({ _id: new ObjectId(anonymous.user.id) }),
    )
    const confirmed = await confirmEmail(email, anonymous.cookie)

    linkerSession = cookieOf(confirmed)

    const listed = await fetch(`${API}/v1/jobs`, { headers: headers(linkerSession) })
    const { jobs } = await listed.json()
    const [linker, afterConfirming] = await withDb((db) =>
        Promise.all([
            db.collection('user').findOne({ email }),
            db.collection('user').findOne({ _id: new ObjectId(anonymous.user.id) }),
        ]),
    )

    assert.equal(signUp.status, 200)
    assert.ok(beforeConfirming, 'sign-up alone creates no session, so nothing is linked yet')
    assert.equal(confirmed.status, 200)
    assert.equal(afterConfirming, null)
    assert.deepEqual(
        linker.runs.map((stored) => stored.id),
        ['anonymous-run'],
    )
    assert.equal(jobs.length, 1)
    assert.equal(purgedPrefixes.length, purgedBefore)
    assert.deepEqual(deletedPaths, [])
})

test('deleting an account also deletes the videos it adopted from an anonymous session', async () => {
    const linker = await withDb((db) => db.collection('user').findOne({ email: 'linker@example.com' }))
    const deleted = await post('/api/auth/delete-user', { password: 'first-password' }, linkerSession)

    assert.equal(deleted.status, 200)
    assert.deepEqual(deletedPaths, [adoptedUpload])
    assert.equal(purgedPrefixes.at(-1), `users/${linker._id.toString()}/`)
})

test('signing in from an anonymous session merges its runs into the existing account', async () => {
    const { ObjectId } = require('mongodb')
    const email = 'returning@example.com'

    await post('/api/auth/sign-up/email', { name: 'Returning', email, password: 'first-password' })
    await settle()
    await confirmEmail(email)

    const anonymous = await signInAnonymously()

    await withDb(async (db) => {
        await db.collection('user').updateOne({ email }, { $set: { runs: [run('own-run')] } })
        await db
            .collection('user')
            .updateOne({ _id: new ObjectId(anonymous.user.id) }, { $set: { runs: [run('anonymous-run')] } })
    })

    const signIn = await post('/api/auth/sign-in/email', { email, password: 'first-password' }, anonymous.cookie)
    const [returning, anonymousAfter] = await withDb((db) =>
        Promise.all([
            db.collection('user').findOne({ email }),
            db.collection('user').findOne({ _id: new ObjectId(anonymous.user.id) }),
        ]),
    )

    assert.equal(signIn.status, 200)
    assert.deepEqual(returning.runs.map((stored) => stored.id).sort(), ['anonymous-run', 'own-run'])
    assert.equal(anonymousAfter, null)
})

test('a verification link for a different email, opened with an anonymous cookie, moves nothing', async () => {
    const { ObjectId } = require('mongodb')
    const attackerEmail = 'attacker@example.com'
    const victim = await signInAnonymously()
    const victimJobPath = `users/${victim.user.id}/jobs/own/video`

    await withDb(async (db) => {
        await db.collection('jobs').insertOne(storedJob(victim.user.id, victimJobPath))
        await db
            .collection('user')
            .updateOne({ _id: new ObjectId(victim.user.id) }, { $set: { runs: [run('victim-run')] } })
    })

    // The attacker signs up with their own address, then mails that confirmation link to the victim instead of
    // opening it themselves. The victim opens it while still holding their own anonymous session cookie.
    await post('/api/auth/sign-up/email', { name: 'Attacker', email: attackerEmail, password: 'first-password' })
    await settle()

    const opened = await confirmEmail(attackerEmail, victim.cookie)
    const body = await opened.json()
    const [victimAfter, attacker] = await withDb((db) =>
        Promise.all([
            db.collection('user').findOne({ _id: new ObjectId(victim.user.id) }),
            db.collection('user').findOne({ email: attackerEmail }),
        ]),
    )
    const victimJobs = await withDb((db) => db.collection('jobs').find({ userId: victim.user.id }).toArray())
    const attackerJobs = await withDb((db) => db.collection('jobs').find({ userId: attacker._id.toString() }).toArray())

    assert.equal(opened.status, 403)
    assert.equal(body.code, 'ACCOUNT_LINK_FAILED')
    assert.ok(victimAfter, "the victim's anonymous user wasn't deleted")
    assert.deepEqual(
        victimAfter.runs.map((stored) => stored.id),
        ['victim-run'],
    )
    assert.equal(victimJobs.length, 1)
    assert.equal(attackerJobs.length, 0)
})

test('a failed move leaves the anonymous user and its data in place', async () => {
    const { ObjectId } = require('mongodb')
    const email = 'unlucky-link@example.com'
    const anonymous = await signInAnonymously()
    const jobPath = `users/${anonymous.user.id}/jobs/own/video`

    await withDb(async (db) => {
        await db.collection('jobs').insertOne(storedJob(anonymous.user.id, jobPath))
        await db
            .collection('user')
            .updateOne({ _id: new ObjectId(anonymous.user.id) }, { $set: { runs: [run('anonymous-run')] } })
    })

    await post('/api/auth/sign-up/email', { name: 'Unlucky Link', email, password: 'first-password' }, anonymous.cookie)
    await settle()

    isAdoptDown = true

    let confirmed
    try {
        confirmed = await confirmEmail(email, anonymous.cookie)
    } finally {
        isAdoptDown = false
    }
    const body = await confirmed.json()
    const [anonymousAfter, linked] = await withDb((db) =>
        Promise.all([
            db.collection('user').findOne({ _id: new ObjectId(anonymous.user.id) }),
            db.collection('user').findOne({ email }),
        ]),
    )
    const anonymousJobs = await withDb((db) => db.collection('jobs').find({ userId: anonymous.user.id }).toArray())

    assert.equal(confirmed.status, 500)
    assert.equal(body.code, 'ACCOUNT_LINK_FAILED')
    assert.ok(linked, 'the account being linked to still exists')
    assert.ok(anonymousAfter, "the anonymous user wasn't deleted")
    assert.deepEqual(
        anonymousAfter.runs.map((stored) => stored.id),
        ['anonymous-run'],
    )
    assert.equal(anonymousJobs.length, 1)
})

test('an anonymous session cannot link a social provider', async () => {
    const anonymous = await signInAnonymously()
    const res = await post(
        '/api/auth/link-social',
        { provider: 'google', callbackURL: `${WEB}/history` },
        anonymous.cookie,
    )
    const body = await res.json()

    assert.equal(res.status, 403)
    assert.equal(body.code, 'ACCOUNT_LINK_FAILED')
})
