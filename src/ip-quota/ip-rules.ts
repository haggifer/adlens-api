import { HttpStatus } from '@nestjs/common'
import { RequestErrorCode } from 'adlens-shared'
import { ApiException } from '../common/api-exception'
import { isProvisional, toProvisionalRefusal, UserAccess } from '../common/user-access'

export interface IpLimits {
    anonymous: number
    soft: number
    hard: number
}

export interface IpUsage {
    total: number
    anonymous: number
}

export interface IpCharge {
    bucketKey: string
    access: UserAccess
    hasPassedChallenge: boolean
}

export enum IpVerdict {
    Allowed = 'allowed',
    NeedsChallenge = 'needs-challenge',
    // The network used its analyses for anonymous users, which unconfirmed accounts share.
    AnonymousLimit = 'anonymous-limit',
    NetworkLimit = 'network-limit',
}

// What one more analysis from a network needs. The soft limit asks for a Turnstile check rather than blocking, so
// people who share a network (an office, a mobile carrier) aren't refused for each other.
export const checkIpRules = (usage: IpUsage, access: UserAccess, limits: IpLimits): IpVerdict => {
    const isLimited = isProvisional(access)

    if (usage.total >= limits.hard) {
        return IpVerdict.NetworkLimit
    }

    if (isLimited && usage.anonymous >= limits.anonymous) {
        return IpVerdict.AnonymousLimit
    }

    if (isLimited || usage.total >= limits.soft) {
        return IpVerdict.NeedsChallenge
    }

    return IpVerdict.Allowed
}

export const toIpRefusal = (verdict: IpVerdict, access: UserAccess): ApiException => {
    switch (verdict) {
        case IpVerdict.NetworkLimit:
            return new ApiException(
                HttpStatus.TOO_MANY_REQUESTS,
                RequestErrorCode.NetworkQuotaExceeded,
                'Too many analyses from this network',
            )
        case IpVerdict.AnonymousLimit:
            return toProvisionalRefusal(access)
        default:
            return new ApiException(HttpStatus.FORBIDDEN, RequestErrorCode.ChallengeRequired, 'A challenge is required')
    }
}
