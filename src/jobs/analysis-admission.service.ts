import { Injectable } from '@nestjs/common'
import { InjectConnection } from '@nestjs/mongoose'
import type { Connection } from 'mongoose'
import { challengeFailed, ChallengeVerifier } from '../challenge/challenge-verifier'
import { readUserAccess, UserAccess } from '../common/user-access'
import type { IpSource } from '../ip-quota/client-ip'
import { ClientNetworkResolver } from '../ip-quota/client-network.resolver'
import { IpQuotaService } from '../ip-quota/ip-quota.service'
import { checkIpRules, type IpCharge, IpVerdict, toIpRefusal } from '../ip-quota/ip-rules'
import { QuotaService, toQuotaRefusal } from '../quota/quota.service'

interface Admission {
    hasPassedChallenge: boolean
}

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
    async admit(userId: string, ipSource: IpSource, challengeToken: string | undefined): Promise<Admission> {
        const access = await this.checkQuota(userId)

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
    async preview(userId: string | null, ipSource: IpSource): Promise<void> {
        const access = userId ? await this.checkQuota(userId) : UserAccess.Anonymous

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

    // Throws when the user's own quota is spent; otherwise returns their access.
    private async checkQuota(userId: string): Promise<UserAccess> {
        const [quota, access] = await Promise.all([this.quota.get(userId), readUserAccess(this.connection, userId)])

        if (quota.limit !== null && quota.used >= quota.limit) {
            throw toQuotaRefusal(access)
        }

        return access
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
