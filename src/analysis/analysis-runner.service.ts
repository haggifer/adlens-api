import { Injectable, Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import type { Analysis } from 'adlens-shared'
import { Model } from 'mongoose'

import { gcsUri, parentFolder, resultPath } from '../common/paths'
import { QuotaService } from '../quota/quota.service'
import {
    buildAdvisories,
    buildFindings,
    evaluateMetadataRules,
    loadRuleSet,
    type MediaFacts,
    projectForModel,
    selectRules,
} from '../rules'
import { JOB_MODEL, JobDocument } from '../schemas/job.schema'
import { StorageService } from '../storage/storage.service'
import { analyzeVideo } from './analyze'

// The full analysis pipeline, run by the worker: metadata checks in code, one multimodal Gemini pass
// over the video for the content rules, advisories for out_of_creative rules, result.json to the
// bucket, and the assembled analysis written back to the job.
@Injectable()
export class AnalysisRunner {
    private readonly logger = new Logger(AnalysisRunner.name)

    constructor(
        @InjectModel(JOB_MODEL) private readonly model: Model<JobDocument>,
        private readonly storage: StorageService,
        private readonly quota: QuotaService,
    ) {}

    async run(userId: string, jobId: string): Promise<void> {
        const job = await this.model.findOne({ _id: jobId, userId })

        if (!job) {
            this.logger.error(`job ${jobId} not found for user ${userId}`)
            return
        }

        if (job.status === 'analyzed') {
            return
        }

        if (!job.file) {
            await this.model.updateOne({ _id: jobId }, { $set: { status: 'error', error: 'No file attached to job' } })
            return
        }

        try {
            await this.model.updateOne({ _id: jobId }, { $set: { status: 'analyzing' } })

            const selected = selectRules(job.settings)
            const facts: MediaFacts = { durationS: job.media?.durationS ?? 0, ...job.media, fileSize: job.file.size }
            const metadataChecks = job.media ? evaluateMetadataRules(selected.metadata, facts) : []
            const advisories = buildAdvisories(selected.advisory)

            const { model, transcript, modelFindings } = await analyzeVideo({
                gcsUri: gcsUri(job.file.bucket, job.file.path),
                mimeType: job.file.contentType,
                contentRules: projectForModel(selected.content),
                settings: job.settings,
            })

            const analysis: Analysis = {
                model,
                rulesetVersion: loadRuleSet().meta.version,
                transcript,
                findings: buildFindings(selected.content, modelFindings),
                metadataChecks,
                advisories,
                completedAt: new Date(),
            }

            const folder = parentFolder(job.file.path)
            await this.storage.saveJson(resultPath(folder), analysis)
            await this.model.updateOne({ _id: jobId }, { $set: { status: 'analyzed', analysis } })
        } catch (err) {
            const shouldRefund = !job.quotaRefunded

            if (shouldRefund) {
                await this.quota.refund(userId)
            }

            await this.model.updateOne(
                { _id: jobId },
                {
                    $set: {
                        status: 'error',
                        error: err instanceof Error ? err.message : 'Analysis failed',
                        ...(shouldRefund ? { quotaRefunded: true } : {}),
                    },
                },
            )

            throw err
        }
    }
}
