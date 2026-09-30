import type { AnalysisSettings } from 'adlens-shared'
import type { TokenUsage } from '../../database/job.doc'
import type { AdvisoryProjection, ModelFinding, RuleProjection } from '../../rules'

export interface VideoReviewRequest {
    videoUri: string
    mimeType: string
    // Caps the times the model may give.
    durationS: number
    rules: RuleProjection[]
    advisories: AdvisoryProjection[]
    settings: AnalysisSettings
}

export interface VideoReview {
    model: string
    promptVersion: string
    transcript: string
    findings: ModelFinding[]
    // The advisories the model found relevant; ids outside the request's are ignored.
    advisoryIds: string[]
    usage: TokenUsage
}

// Watches the video and judges the content rules against it. Implementations throw RetryableError for transient
// provider failures and anything else for failures a retry can't fix.
export abstract class VideoReviewer {
    abstract review(request: VideoReviewRequest): Promise<VideoReview>
}
