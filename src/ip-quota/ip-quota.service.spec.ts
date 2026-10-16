import { HttpStatus } from '@nestjs/common'
import { QUOTA_WINDOW_MS, RequestErrorCode } from 'adlens-shared'
import { UserAccess } from '../common/user-access'
import { IP_QUOTA_COLLECTION, IP_QUOTA_MODEL, type IpQuotaDoc, IpQuotaSchema } from '../database/ip-quota.doc'
import { configStub } from '../testing/config-stub'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { IpQuotaService } from './ip-quota.service'
import type { IpCharge } from './ip-rules'

const LIMITS = { IP_ANON_LIMIT: 3, IP_SOFT_LIMIT: 5, IP_HARD_LIMIT: 8 }
const NOW = new Date('2026-09-28T10:00:00Z')
const NETWORK = 'network-key'

const member = (overrides: Partial<IpCharge> = {}): IpCharge => ({
    bucketKey: NETWORK,
    access: UserAccess.Member,
    hasPassedChallenge: false,
    ...overrides,
})

const anonymous = (overrides: Partial<IpCharge> = {}): IpCharge =>
    member({ access: UserAccess.Anonymous, hasPassedChallenge: true, ...overrides })

const unconfirmed = (overrides: Partial<IpCharge> = {}): IpCharge =>
    member({ access: UserAccess.Unconfirmed, hasPassedChallenge: true, ...overrides })

describe('IpQuotaService', () => {
    let mongo: MemoryMongo
    let ipQuota: IpQuotaService

    const buckets = () => mongo.connection.collection<IpQuotaDoc>(IP_QUOTA_COLLECTION)

    const chargeTimes = async (count: number, charge: IpCharge) => {
        for (let i = 0; i < count; i++) {
            await ipQuota.charge(charge, `job-${i}`, NOW)
        }
    }

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        await mongo.connection.model(IP_QUOTA_MODEL, IpQuotaSchema).init()
        ipQuota = new IpQuotaService(mongo.connection, configStub(LIMITS))
    })

    afterEach(async () => {
        await buckets().deleteMany({})
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it('reports an unused network', async () => {
        expect(await ipQuota.usage(NETWORK, NOW)).toEqual({ total: 0, anonymous: 0 })
    })

    it('charges a run and sets the network to expire a window later', async () => {
        const runId = await ipQuota.charge(anonymous(), 'job-1', NOW)

        expect(await buckets().findOne({ _id: NETWORK })).toMatchObject({
            runs: [{ id: runId, startedAt: NOW, jobId: 'job-1', anonymous: true }],
            expiresAt: new Date(NOW.getTime() + QUOTA_WINDOW_MS),
        })
        expect(await ipQuota.usage(NETWORK, NOW)).toEqual({ total: 1, anonymous: 1 })
    })

    it('sends anonymous users to sign up once the network used its anonymous analyses, but not members', async () => {
        await chargeTimes(LIMITS.IP_ANON_LIMIT, anonymous())

        await expect(ipQuota.charge(anonymous(), 'job-extra', NOW)).rejects.toMatchObject({
            status: HttpStatus.TOO_MANY_REQUESTS,
            response: { errorCode: RequestErrorCode.SignUpRequired },
        })
        await expect(ipQuota.charge(member(), 'job-member', NOW)).resolves.toEqual(expect.any(String))
    })

    it("counts unconfirmed accounts' runs against the anonymous allowance, and asks them to confirm at its end", async () => {
        await chargeTimes(LIMITS.IP_ANON_LIMIT - 1, anonymous())
        await ipQuota.charge(unconfirmed(), 'job-unconfirmed', NOW)

        expect(await ipQuota.usage(NETWORK, NOW)).toEqual({
            total: LIMITS.IP_ANON_LIMIT,
            anonymous: LIMITS.IP_ANON_LIMIT,
        })
        await expect(ipQuota.charge(unconfirmed(), 'job-extra', NOW)).rejects.toMatchObject({
            status: HttpStatus.TOO_MANY_REQUESTS,
            response: { errorCode: RequestErrorCode.EmailConfirmationRequired },
        })
    })

    it('never charges an unconfirmed account that has not passed a challenge', async () => {
        await expect(ipQuota.charge(unconfirmed({ hasPassedChallenge: false }), 'job-1', NOW)).rejects.toMatchObject({
            response: { errorCode: RequestErrorCode.ChallengeRequired },
        })
    })

    it("doesn't count members' runs against the anonymous allowance", async () => {
        await chargeTimes(LIMITS.IP_ANON_LIMIT, member())

        await expect(ipQuota.charge(anonymous(), 'job-anonymous', NOW)).resolves.toEqual(expect.any(String))
        expect(await ipQuota.usage(NETWORK, NOW)).toEqual({ total: LIMITS.IP_ANON_LIMIT + 1, anonymous: 1 })
    })

    it('never charges an anonymous user who has not passed a challenge', async () => {
        await expect(ipQuota.charge(anonymous({ hasPassedChallenge: false }), 'job-1', NOW)).rejects.toMatchObject({
            status: HttpStatus.FORBIDDEN,
            response: { errorCode: RequestErrorCode.ChallengeRequired },
        })
        expect(await ipQuota.usage(NETWORK, NOW)).toEqual({ total: 0, anonymous: 0 })
    })

    it('asks everyone for a challenge from the soft limit on', async () => {
        await chargeTimes(LIMITS.IP_SOFT_LIMIT, member())

        await expect(ipQuota.charge(member(), 'job-unchecked', NOW)).rejects.toMatchObject({
            response: { errorCode: RequestErrorCode.ChallengeRequired },
        })
        await expect(ipQuota.charge(member({ hasPassedChallenge: true }), 'job-checked', NOW)).resolves.toEqual(
            expect.any(String),
        )
    })

    it('stops everyone at the hard limit', async () => {
        await chargeTimes(LIMITS.IP_HARD_LIMIT, member({ hasPassedChallenge: true }))

        await expect(ipQuota.charge(member({ hasPassedChallenge: true }), 'job-extra', NOW)).rejects.toMatchObject({
            status: HttpStatus.TOO_MANY_REQUESTS,
            response: { errorCode: RequestErrorCode.NetworkQuotaExceeded },
        })
    })

    it('never overdraws under concurrent charges', async () => {
        const results = await Promise.allSettled(
            Array.from({ length: 6 }, (_, i) => ipQuota.charge(anonymous(), `job-${i}`, NOW)),
        )

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(LIMITS.IP_ANON_LIMIT)
        expect(await ipQuota.usage(NETWORK, NOW)).toEqual({
            total: LIMITS.IP_ANON_LIMIT,
            anonymous: LIMITS.IP_ANON_LIMIT,
        })
    })

    it('stops counting a run a window after it started, and drops it on the next charge', async () => {
        await chargeTimes(LIMITS.IP_ANON_LIMIT, anonymous())

        const later = new Date(NOW.getTime() + QUOTA_WINDOW_MS + 1)

        expect(await ipQuota.usage(NETWORK, later)).toEqual({ total: 0, anonymous: 0 })
        await expect(ipQuota.charge(anonymous(), 'job-later', later)).resolves.toEqual(expect.any(String))
        expect((await buckets().findOne({ _id: NETWORK }))?.runs).toHaveLength(1)
    })

    it('charges the run under the id the caller recorded for it', async () => {
        expect(await ipQuota.charge(member(), 'job-1', NOW, 'run-1')).toBe('run-1')
        expect((await buckets().findOne({ _id: NETWORK }))?.runs.map((run) => run.id)).toEqual(['run-1'])
    })

    it('refunds exactly the given run, found by its id alone', async () => {
        const kept = await ipQuota.charge(member(), 'job-1', NOW)
        const refunded = await ipQuota.charge(member(), 'job-2', NOW)

        await ipQuota.refund(refunded)
        await ipQuota.refund('unknown-run')

        expect((await buckets().findOne({ _id: NETWORK }))?.runs.map((run) => run.id)).toEqual([kept])
    })

    it('pushes the expiry out with every charge', async () => {
        const later = new Date(NOW.getTime() + 24 * 60 * 60 * 1000)

        await ipQuota.charge(member(), 'job-1', NOW)
        await ipQuota.charge(member(), 'job-2', later)

        expect((await buckets().findOne({ _id: NETWORK }))?.expiresAt).toEqual(
            new Date(later.getTime() + QUOTA_WINDOW_MS),
        )
    })

    it('extends a nearly expired network before charging it, so MongoDB cannot delete it mid-charge', async () => {
        const runs = Array.from({ length: LIMITS.IP_HARD_LIMIT }, (_, i) => ({
            id: `run-${i}`,
            startedAt: NOW,
            jobId: `job-${i}`,
            anonymous: false,
        }))

        await buckets().insertOne({ _id: NETWORK, runs, expiresAt: new Date(NOW.getTime() + 1000) })
        await expect(ipQuota.charge(member({ hasPassedChallenge: true }), 'job-extra', NOW)).rejects.toMatchObject({
            response: { errorCode: RequestErrorCode.NetworkQuotaExceeded },
        })

        expect((await buckets().findOne({ _id: NETWORK }))?.expiresAt).toEqual(
            new Date(NOW.getTime() + QUOTA_WINDOW_MS),
        )
    })

    it('lets MongoDB expire a network and find a run by id through indexes', async () => {
        expect(await buckets().indexes()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
                expect.objectContaining({ key: { 'runs.id': 1 } }),
            ]),
        )
    })
})
