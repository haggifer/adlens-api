// The only part of this source tree adlens-lab may import: its server runs the real analysis code (the Gemini request,
// the reading of the answer, the assembly) and its ops scripts publish through the real models. Anything the lab needs
// is exported here, so knip sees it used and a change to this surface is a change to the lab. Not part of the build.

export { CloudRunDispatcher } from './analysis/dispatch/cloud-run.dispatcher'
export { buildAnalysis, toReviewRequest } from './analysis/pipeline/analysis-assembly'
export { ModelAnswerError } from './analysis/pipeline/model-answer-error'
export {
    buildReviewConfig,
    buildReviewContents,
    GEMINI_MAX_OUTPUT_TOKENS,
    GEMINI_REQUEST_TIMEOUT_MS,
    isRetryableStatus,
    readReview,
} from './analysis/review/gemini-review'
export { PROMPT_VERSION } from './analysis/review/review-prompt'
export type { VideoReview, VideoReviewRequest } from './analysis/review/video-reviewer'
export { gcsUri } from './common/paths'
export { DEFAULT_GEMINI_LOCATION, DEFAULT_GEMINI_MODEL } from './config/gemini-defaults'
export { DEMO_OWNER, JOB_MODEL, type JobDoc, JobSchema } from './database/job.doc'
export { RULESET_MODEL, RulesetSchema } from './database/ruleset.doc'
export { SAMPLE_MODEL, SampleSchema } from './database/sample.doc'
export { MediaProber, type ProbeResult, UndecodableMediaError } from './jobs/verification/media-prober'
export { resolveSettings, type SelectedRules, selectRules } from './rules'
export { type Rule, RULE_PLATFORMS, type RuleSet, ruleSetSchema } from './rules/schema'
export { StorageService } from './storage/storage.service'
export { configStub } from './testing/config-stub'
export { TEST_RULESET } from './testing/test-ruleset'
