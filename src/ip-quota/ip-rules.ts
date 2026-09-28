import { HttpStatus } from '@nestjs/common'
import { RequestErrorCode } from 'adlens-shared'
import { ApiException } from '../common/api-exception'

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
    isAnonymous: boolean
    hasPassedChallenge: boolean
}

export enum IpVerdict {
    Allowed = 'allowed',
    NeedsChallenge = 'needs-challenge',
    SignUpRequired = 'sign-up-required',
    NetworkLimit = 'network-limit',
}

// What one more analysis from a network needs. The soft limit asks for a Turnstile check rather than blocking, so
// people who share a network (an office, a mobile carrier) aren't refused for each other.
export const checkIpRules = (usage: IpUsage, isAnonymous: boolean, limits: IpLimits): IpVerdict => {
    if (usage.total >= limits.hard) {
        return IpVerdict.NetworkLimit
    }

    if (isAnonymous && usage.anonymous >= limits.anonymous) {
        return IpVerdict.SignUpRequired
    }

    if (isAnonymous || usage.total >= limits.soft) {
        return IpVerdict.NeedsChallenge
    }

    return IpVerdict.Allowed
}

export const toIpRefusal = (verdict: IpVerdict): ApiException => {
    switch (verdict) {
        case IpVerdict.NetworkLimit:
            return new ApiException(
                HttpStatus.TOO_MANY_REQUESTS,
                RequestErrorCode.NetworkQuotaExceeded,
                'Too many analyses from this network',
            )
        case IpVerdict.SignUpRequired:
            return new ApiException(
                HttpStatus.TOO_MANY_REQUESTS,
                RequestErrorCode.SignUpRequired,
                'Sign up to keep analysing',
            )
        default:
            return new ApiException(HttpStatus.FORBIDDEN, RequestErrorCode.ChallengeRequired, 'A challenge is required')
    }
}
