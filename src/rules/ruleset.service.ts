import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { RULESET_MODEL, type RulesetDoc } from '../database/ruleset.doc'
import { type RuleSet, ruleSetSchema } from './schema'

// Serves the newest published ruleset, loaded once per process. A worker analyzes one job and exits, so each analysis
// runs the version that was current when it started; publishing a new version needs no redeploy.
@Injectable()
export class RulesetService {
    private latest?: Promise<RuleSet>

    constructor(@InjectModel(RULESET_MODEL) private readonly model: Model<RulesetDoc>) {}

    current(): Promise<RuleSet> {
        this.latest ??= this.loadLatest().catch((err: unknown) => {
            this.latest = undefined
            throw err
        })

        return this.latest
    }

    private async loadLatest(): Promise<RuleSet> {
        const doc = await this.model.findOne().sort({ publishedAt: -1 }).lean<RulesetDoc>()

        if (!doc) {
            throw new Error('No ruleset has been published (npm run rules:publish)')
        }

        return ruleSetSchema.parse(doc.ruleset)
    }
}
