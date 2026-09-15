import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectModel } from '@nestjs/mongoose'
import type { Quota as QuotaEntity } from 'adlens-shared'
import { Model } from 'mongoose'

import { Quota, QuotaDocument } from '../schemas/quota.schema'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

@Injectable()
export class QuotaService {
    private readonly defaultLimit: number

    constructor(
        @InjectModel(Quota.name) private readonly model: Model<QuotaDocument>,
        config: ConfigService,
    ) {
        this.defaultLimit = Number(config.get('QUOTA_LIMIT') ?? 3)
    }

    // The only place a run is counted. The doc is server-owned, so quota is unspoofable. Atomicity comes
    // from a single findOneAndUpdate guarded by used < limit ($expr) — no transaction needed.
    async consume(userId: string): Promise<void> {
        const now = Date.now()

        await this.model.updateOne(
            { userId },
            { $setOnInsert: { used: 0, limit: this.defaultLimit, windowStart: now } },
            { upsert: true },
        )

        await this.model.updateOne(
            { userId, windowStart: { $lt: now - WEEK_MS } },
            { $set: { used: 0, windowStart: now } },
        )

        const updated = await this.model.findOneAndUpdate(
            { userId, $expr: { $lt: ['$used', '$limit'] } },
            { $inc: { used: 1 } },
            { new: true },
        )

        if (!updated) {
            throw new HttpException('Weekly limit reached', HttpStatus.TOO_MANY_REQUESTS)
        }
    }

    async get(userId: string): Promise<QuotaEntity> {
        const now = Date.now()
        const doc = await this.model.findOne({ userId })

        if (!doc) {
            return { used: 0, limit: this.defaultLimit, windowStart: now }
        }

        if (now - doc.windowStart >= WEEK_MS) {
            return { used: 0, limit: doc.limit, windowStart: now }
        }

        return { used: doc.used, limit: doc.limit, windowStart: doc.windowStart }
    }
}
