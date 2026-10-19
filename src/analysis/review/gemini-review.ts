import {
    type Content,
    createPartFromUri,
    createUserContent,
    FinishReason,
    type GenerateContentConfig,
    type GenerateContentResponse,
} from '@google/genai'
import { describeError } from '../../common/error-message'
import type { ModelCall } from '../../database/job.doc'
import { ModelAnswerError } from '../pipeline/model-answer-error'
import { type ModelCallContext, toModelCall } from './model-call'
import { buildReviewOutputJsonSchema, buildReviewPrompt, parseReviewOutput, PROMPT_VERSION } from './review-prompt'
import type { VideoReview, VideoReviewRequest } from './video-reviewer'

// The Gemini request a review sends and how its answer is read, without the client: GeminiVideoReviewer sends it, and
// the lab (adlens-lab) sends the same request with its overrides on top, so both read answers the same way.

// Well under the Cloud Run task timeout (15 min), so a hung call ends in a handled failure, not a killed task.
export const GEMINI_REQUEST_TIMEOUT_MS = 10 * 60 * 1000

// A ceiling on a runaway generation's cost per attempt, not a budget: a reply is billed for what it generates. The
// largest stored reply (2026-10-19, 45 calls, ads up to 3.5 minutes) was about 5,000 tokens, thinking included, so the
// cap leaves about three times that. The lab shows it as production's cap.
/** @public */
export const GEMINI_MAX_OUTPUT_TOKENS = 16384

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])

// An HTTP error status Vertex may answer differently on another attempt: overload, rate limits and server errors.
export const isRetryableStatus = (status: number): boolean => RETRYABLE_STATUSES.has(status)

// The video, then the prompt.
export const buildReviewContents = ({ videoUri, mimeType, rules, advisories, settings }: VideoReviewRequest): Content =>
    createUserContent([createPartFromUri(videoUri, mimeType), buildReviewPrompt(settings, rules, advisories)])

// Temperature stays at the Gemini 3 default (1.0); Google warns that lower values can make these models loop.
export const buildReviewConfig = ({ durationS }: VideoReviewRequest): GenerateContentConfig => ({
    responseMimeType: 'application/json',
    responseJsonSchema: buildReviewOutputJsonSchema(durationS),
    maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
})

const parseAnswer = (text: string | undefined, call: ModelCall) => {
    try {
        return parseReviewOutput(text)
    } catch (err) {
        throw new ModelAnswerError(`The model returned malformed output: ${describeError(err)}`, call, { cause: err })
    }
}

// The review in Gemini's answer. Throws ModelAnswerError, carrying the billed call, for an answer that can't be used.
export const readReview = (response: GenerateContentResponse, context: ModelCallContext): VideoReview => {
    const finishReason = response.candidates?.[0]?.finishReason
    const call = toModelCall(response.usageMetadata, finishReason, context)

    // A blocked prompt gets no candidates. Blocked content won't change on a retry.
    const blockReason = response.promptFeedback?.blockReason

    if (blockReason || !response.candidates?.length) {
        throw new ModelAnswerError(`The prompt was blocked: ${blockReason ?? 'no candidates'}`, call)
    }

    // Every answer is billed. A cut-off one comes from the prompt and video, not chance (the whole-second timestamps
    // stopped the runaways), so another attempt would most likely pay for the same cut-off answer.
    if (finishReason === FinishReason.MAX_TOKENS) {
        throw new ModelAnswerError('The model output was cut off at the token limit', call)
    }

    // Blocked or refused content won't change on a retry.
    if (finishReason && finishReason !== FinishReason.STOP) {
        throw new ModelAnswerError(`The model stopped early: ${finishReason}`, call)
    }

    const output = parseAnswer(response.text, call)

    return {
        model: context.model,
        promptVersion: PROMPT_VERSION,
        transcript: output.transcript,
        findings: output.findings,
        advisoryIds: output.advisoryIds,
        call,
    }
}
