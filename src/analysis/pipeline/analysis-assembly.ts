import type { Analysis, AnalysisSettings, JobMedia } from 'adlens-shared'
import {
    buildAdvisories,
    buildFindings,
    evaluateMetadataRules,
    projectAdvisoriesForModel,
    projectForModel,
    type SelectedRules,
} from '../../rules'
import type { RuleSet } from '../../rules/schema'
import type { VideoReview, VideoReviewRequest } from '../review/video-reviewer'

// The video a review watches.
export interface ReviewVideo {
    videoUri: string
    mimeType: string
}

// How an analysis is put together around the model's review, without the job: AnalysisPipeline runs it for a job,
// and the lab (adlens-lab) for its own videos.

export const toReviewRequest = (
    { videoUri, mimeType }: ReviewVideo,
    media: JobMedia,
    settings: AnalysisSettings,
    selected: SelectedRules,
): VideoReviewRequest => ({
    videoUri,
    mimeType,
    durationS: media.durationS,
    rules: projectForModel(selected.content),
    advisories: projectAdvisoriesForModel(selected.advisory),
    settings,
})

// `settings` resolved (resolveSettings): an empty setting stands for every value.
export const buildAnalysis = (
    ruleSet: RuleSet,
    selected: SelectedRules,
    review: VideoReview,
    media: JobMedia,
    settings: AnalysisSettings,
): Analysis => ({
    model: review.model,
    promptVersion: review.promptVersion,
    rulesetVersion: ruleSet.meta.version,
    transcript: review.transcript,
    findings: buildFindings(ruleSet, selected.content, review.findings),
    metadataChecks: evaluateMetadataRules(ruleSet, selected.metadata, media, settings.placements, settings.platforms),
    advisories: buildAdvisories(
        ruleSet,
        selected.advisory.filter((rule) => review.advisoryIds.includes(rule.id)),
    ),
    completedAt: new Date().toISOString(),
})
