import { HttpStatus, Injectable } from '@nestjs/common'
import { InjectConnection } from '@nestjs/mongoose'
import { RequestErrorCode } from 'adlens-shared'
import { type Connection, Types } from 'mongoose'
import { ChallengeVerifier } from '../challenge/challenge-verifier'
import { ApiException } from '../common/api-exception'
import { USER_COLLECTION, type UserExtras } from '../database/user.doc'
import type { IpSource } from '../ip-quota/client-ip'
import { ClientNetworkResolver } from '../ip-quota/client-network.resolver'
import { IpQuotaService } from '../ip-quota/ip-quota.service'
import { checkIpRules, type IpCharge, IpVerdict, toIpRefusal } from '../ip-quota/ip-rules'
import { quotaExceeded, QuotaService } from '../quota/quota.service'

export interface Admission {
    hasPassedChallenge: boolean
}

const challengeFailed = () =>
    new ApiException(HttpStatus.FORBIDDEN, RequestErrorCode.ChallengeFailed, 'The challenge did not pass')

// Whether a user may start one more analysis from their network. Admins skip every network rule, as they skip the
// user cap.
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
        const [quota, user] = await Promise.all([this.quota.get(userId), this.findUser(userId)])

        if (quota.limit !== null && quota.used >= quota.limit) {
            throw quotaExceeded()
        }

        if (user?.isAdmin) {
            return { hasPassedChallenge: false }
        }

        const { ip, bucketKey } = this.network.resolve(ipSource)
        const usage = await this.ipQuota.usage(bucketKey)
        const verdict = checkIpRules(usage, Boolean(user?.isAnonymous), this.ipQuota.limits)

        if (verdict === IpVerdict.Allowed) {
            return { hasPassedChallenge: false }
        }

        if (verdict !== IpVerdict.NeedsChallenge || !challengeToken) {
            throw toIpRefusal(verdict)
        }

        const isHuman = await this.challenge.verify(challengeToken, ip)

        if (!isHuman) {
            throw challengeFailed()
        }

        return { hasPassedChallenge: true }
    }

    // At analyze: what to charge the network, or null for an admin.
    async ipChargeFor(userId: string, ipSource: IpSource, hasPassedChallenge: boolean): Promise<IpCharge | null> {
        const user = await this.findUser(userId)

        if (user?.isAdmin) {
            return null
        }

        return {
            bucketKey: this.network.resolve(ipSource).bucketKey,
            isAnonymous: Boolean(user?.isAnonymous),
            hasPassedChallenge,
        }
    }

    private findUser(userId: string) {
        return this.connection
            .collection<UserExtras>(USER_COLLECTION)
            .findOne({ _id: new Types.ObjectId(userId) }, { projection: { isAdmin: 1, isAnonymous: 1 } })
    }
}
