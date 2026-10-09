import { Injectable } from '@nestjs/common'
import { InjectConnection } from '@nestjs/mongoose'
import { type Connection, Types } from 'mongoose'
import { challengeFailed, ChallengeVerifier } from '../challenge/challenge-verifier'
import {
    getUserAccess,
    isProvisional,
    readUserAccess,
    toProvisionalRefusal,
    USER_ACCESS_PROJECTION,
    UserAccess,
} from '../common/user-access'
import { USER_COLLECTION, type UserExtras } from '../database/user.doc'
import type { IpSource } from '../ip-quota/client-ip'
import { ClientNetworkResolver } from '../ip-quota/client-network.resolver'
import { IpQuotaService } from '../ip-quota/ip-quota.service'
import { checkIpRules, type IpCharge, IpVerdict, toIpRefusal } from '../ip-quota/ip-rules'
import { QuotaService } from '../quota/quota.service'

type FreeRunHolder = Pick<UserExtras, 'isAdmin' | 'isAnonymous' | 'emailVerified' | 'freeRunId'>

interface Admission {
    hasPassedChallenge: boolean
}

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i

// A provisional user's charge records its run as freeRunId and a refund clears it, so a provisional user without one
// holds no run: the analysis the cookie remembers was refunded. Anyone else counts: a user that is gone (an anonymous
// user deleted after a week, or linked from another browser), or an account that was confirmed, whose runs never
// record a freeRunId; any analysis there uses up the browser's one.
const isRunHeldBy = (holder: FreeRunHolder | null): boolean =>
    !holder || !isProvisional(getUserAccess(holder)) || Boolean(holder.freeRunId)

// Whether a user may start one more analysis from their network. Admins skip every network rule, as they skip the
// user cap; an unconfirmed account meets the rules of an anonymous user.
@Injectable()
export class AnalysisAdmission {
    constructor(
        @InjectConnection() private readonly connection: Connection,
        private readonly quota: QuotaService,
        private readonly ipQuota: IpQuotaService,
        private readonly network: ClientNetworkResolver,
        private readonly challenge: ChallengeVerifier,
    ) {}

    // At job creation, read-only, so nobody uploads a video only to be refused at analyze. The Turnstile token is
    // verified only when a rule asks for it, and the job records that it passed.
    async admit(
        userId: string,
        ipSource: IpSource,
        challengeToken: string | undefined,
        freeRunUserId: string | null,
    ): Promise<Admission> {
        const access = await this.quota.check(userId)

        await this.checkFreeRun(access, userId, freeRunUserId)

        if (access === UserAccess.Admin) {
            return { hasPassedChallenge: false }
        }

        const { ip, verdict } = await this.checkNetwork(access, ipSource)

        if (verdict === IpVerdict.Allowed) {
            return { hasPassedChallenge: false }
        }

        if (verdict !== IpVerdict.NeedsChallenge || !challengeToken) {
            throw toIpRefusal(verdict, access)
        }

        const isHuman = await this.challenge.verify(challengeToken, ip)

        if (!isHuman) {
            throw challengeFailed()
        }

        return { hasPassedChallenge: true }
    }

    // Throws the refusal admit would throw before any Turnstile check, so the web can disable Run in advance. A visitor
    // without a session is judged as the anonymous user their first analysis starts, whose own quota is still unused.
    async preview(userId: string | null, ipSource: IpSource, freeRunUserId: string | null): Promise<void> {
        const access = userId ? await this.quota.check(userId) : UserAccess.Anonymous

        await this.checkFreeRun(access, userId, freeRunUserId)

        if (access === UserAccess.Admin) {
            return
        }

        const { verdict } = await this.checkNetwork(access, ipSource)

        if (verdict === IpVerdict.AnonymousLimit || verdict === IpVerdict.NetworkLimit) {
            throw toIpRefusal(verdict, access)
        }
    }

    // At analyze: what to charge the network, or null for an admin.
    async ipChargeFor(userId: string, ipSource: IpSource, hasPassedChallenge: boolean): Promise<IpCharge | null> {
        const access = await readUserAccess(this.connection, userId)

        if (access === UserAccess.Admin) {
            return null
        }

        return { bucketKey: this.network.resolve(ipSource).bucketKey, access, hasPassedChallenge }
    }

    // One analysis per browser before an email is confirmed: once anyone ran one there (freeRunUserId), a visitor, an
    // anonymous user or an unconfirmed account in that browser must sign up or confirm, unless that run was refunded.
    // The user who ran it may retry a refunded run; the quota check stops them otherwise.
    private async checkFreeRun(access: UserAccess, userId: string | null, freeRunUserId: string | null): Promise<void> {
        if (!isProvisional(access) || freeRunUserId === null || freeRunUserId === userId) {
            return
        }

        const holder = await this.findFreeRunHolder(freeRunUserId)

        if (isRunHeldBy(holder)) {
            throw toProvisionalRefusal(access)
        }
    }

    // null for a value that names no user, a hand-edited cookie among them.
    private findFreeRunHolder(userId: string): Promise<FreeRunHolder | null> {
        if (!OBJECT_ID_PATTERN.test(userId)) {
            return Promise.resolve(null)
        }

        return this.connection
            .collection<UserExtras>(USER_COLLECTION)
            .findOne({ _id: new Types.ObjectId(userId) }, { projection: { ...USER_ACCESS_PROJECTION, freeRunId: 1 } })
    }

    private async checkNetwork(
        access: UserAccess,
        ipSource: IpSource,
    ): Promise<{ ip: string | null; verdict: IpVerdict }> {
        const { ip, bucketKey } = this.network.resolve(ipSource)
        const usage = await this.ipQuota.usage(bucketKey)

        return { ip, verdict: checkIpRules(usage, access, this.ipQuota.limits) }
    }
}
