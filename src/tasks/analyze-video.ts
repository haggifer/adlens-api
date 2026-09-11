import { Timestamp } from 'firebase-admin/firestore'
import { onTaskDispatched } from 'firebase-functions/v2/tasks'
import type { Analysis } from 'adlens-types'

import { storage } from '@/infra/firebase'
import {
    buildAdvisories,
    buildFindings,
    evaluateMetadataRules,
    loadRuleSet,
    type MediaFacts,
    projectForModel,
    selectRules,
} from '@/rules/index'
import { analyzeVideo as runAnalysis } from '@/services/analyze'
import { getJob, updateJob } from '@/services/jobs'
import { gcsUri, parentFolder, resultPath } from '@/utils/paths'

// Identifiers only — the worker re-fetches state from Firestore.
export interface AnalyzePayload {
    uid: string
    jobId: string
}

// Export name doubles as the queue name used by the enqueue call in the analyze route.
export const analyzeVideo = onTaskDispatched<AnalyzePayload>(
    {
        memory: '1GiB',
        timeoutSeconds: 540,
        retryConfig: { maxAttempts: 3, minBackoffSeconds: 5 },
        rateLimits: { maxConcurrentDispatches: 6 },
    },
    async (req) => {
        const { uid, jobId } = req.data
        const job = await getJob(uid, jobId)

        if (!job.file) {
            await updateJob(uid, jobId, { status: 'error', error: 'No file attached to job' })
            return
        }

        try {
            await updateJob(uid, jobId, { status: 'analyzing' })

            const selected = selectRules(job.settings)
            const facts: MediaFacts = { durationS: job.media?.durationS ?? 0, ...job.media, fileSize: job.file.size }
            const metadataChecks = job.media ? evaluateMetadataRules(selected.metadata, facts) : []
            const advisories = buildAdvisories(selected.advisory)

            const { model, transcript, modelFindings } = await runAnalysis({
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
                completedAt: Timestamp.now(),
            }

            const folder = parentFolder(job.file.path)
            await storage
                .bucket(job.file.bucket)
                .file(resultPath(folder))
                .save(JSON.stringify(analysis, null, 2), { contentType: 'application/json' })

            await updateJob(uid, jobId, { status: 'analyzed', analysis })
        } catch (err) {
            await updateJob(uid, jobId, {
                status: 'error',
                error: err instanceof Error ? err.message : 'Analysis failed',
            })
            throw err
        }
    },
)
