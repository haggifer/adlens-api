import { HttpStatus, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectModel } from '@nestjs/mongoose'
import { type Quota, QUOTA_WINDOW_MS, RequestErrorCode } from 'adlens-shared'
import { Model } from 'mongoose'
import { ApiException } from '../common/api-exception'
import type { Env } from '../config/env'
import { QUOTA_MODEL, type QuotaDoc } from '../database/quota.doc'

// A window is closed when it never opened, holds a pre-Date legacy value, or started more than a window ago.
const isWindowClosed = (cutoff: Date) => ({
    $or: [{ $ne: [{ $type: '$windowStart' }, 'date'] }, { $lt: ['$windowStart', cutoff] }],
})

@Injectable()
export class QuotaService {
    private readonly defaultLimit: number

    constructor(
        @InjectModel(QUOTA_MODEL) private readonly model: Model<QuotaDoc>,
        config: ConfigService<Env, true>,
    ) {
        this.defaultLimit = config.get('QUOTA_LIMIT', { infer: true })
    }

    // Charges one run and returns the window it was charged to. The charge is a single conditional update: it
    // matches only when the window is closed (it restarts at 1), still has room, or the account is unlimited, so
    // concurrent calls can't overdraw.
    async consume(userId: string, now = new Date()): Promise<Date> {
        await this.model.updateOne(
            { userId },
            { $setOnInsert: { used: 0, limit: this.defaultLimit, windowStart: null } },
            { upsert: true },
        )

        const closed = isWindowClosed(new Date(now.getTime() - QUOTA_WINDOW_MS))
        const charged = await this.model
            .findOneAndUpdate(
                {
                    userId,
                    $expr: { $or: [closed, { $lt: ['$used', '$limit'] }, { $eq: ['$isUnlimited', true] }] },
                },
                [
                    {
                        $set: {
                            windowStart: { $cond: [closed, now, '$windowStart'] },
                            used: { $cond: [closed, 1, { $add: ['$used', 1] }] },
                        },
                    },
                ],
                { new: true },
            )
            .lean<QuotaDoc>()

        if (!charged?.windowStart) {
            throw new ApiException(
                HttpStatus.TOO_MANY_REQUESTS,
                RequestErrorCode.QuotaExceeded,
                'Analysis limit reached',
            )
        }

        return charged.windowStart
    }

    // Gives a charge back, but only to the window it was taken from: a refund after the window rolled over is dropped.
    async refund(userId: string, windowStart: Date): Promise<void> {
        await this.model.updateOne({ userId, windowStart, used: { $gt: 0 } }, { $inc: { used: -1 } })
    }

    async get(userId: string, now = new Date()): Promise<Quota> {
        const doc = await this.model.findOne({ userId }).lean<QuotaDoc>()
        const limit = doc?.isUnlimited ? null : (doc?.limit ?? this.defaultLimit)
        const windowStart = doc?.windowStart instanceof Date ? doc.windowStart : null

        if (!doc || !windowStart || now.getTime() - windowStart.getTime() >= QUOTA_WINDOW_MS) {
            return { used: 0, limit, windowStart: null }
        }

        return { used: doc.used, limit, windowStart: windowStart.toISOString() }
    }
}
