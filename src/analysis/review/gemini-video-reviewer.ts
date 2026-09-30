import {
    ApiError,
    createPartFromUri,
    createUserContent,
    FinishReason,
    type GenerateContentResponse,
    GoogleGenAI,
} from '@google/genai'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Env } from '../../config/env'
import type { TokenUsage } from '../../database/job.doc'
import { ModelAnswerError } from '../pipeline/model-answer-error'
import { RetryableError } from '../pipeline/retryable-error'
import {
    buildReviewOutputJsonSchema,
    buildReviewPrompt,
    parseReviewOutput,
    PROMPT_VERSION,
    type ReviewOutput,
} from './review-prompt'
import { type VideoReview, VideoReviewer, type VideoReviewRequest } from './video-reviewer'

// Well under the Cloud Run task timeout (15 min), so a hung call ends in a handled failure, not a killed task.
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000

// A full answer for ~60 rules and a 60-second transcript is a few thousand tokens; the cap bounds what a runaway
// generation can cost per attempt.
const MAX_OUTPUT_TOKENS = 8192

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])

const toUsage = (usage: GenerateContentResponse['usageMetadata']): TokenUsage => ({
    promptTokens: usage?.promptTokenCount ?? 0,
    outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    totalTokens: usage?.totalTokenCount ?? 0,
})

const toReviewError = (err: unknown): Error => {
    if (err instanceof ApiError && !RETRYABLE_STATUSES.has(err.status)) {
        return err
    }

    // Provider overload, timeouts and network failures.
    return new RetryableError(err instanceof Error ? err.message : String(err), { cause: err })
}

// Gemini on Vertex AI: authenticates with ADC and reads the video straight from its gs:// URI. Temperature stays at the
// Gemini 3 default (1.0); Google warns that lower values can make these models loop.
@Injectable()
export class GeminiVideoReviewer extends VideoReviewer {
    private readonly client: GoogleGenAI
    private readonly model: string

    constructor(config: ConfigService<Env, true>) {
        super()
        this.model = config.get('GEMINI_MODEL', { infer: true })
        this.client = new GoogleGenAI({
            vertexai: true,
            project: config.get('GOOGLE_CLOUD_PROJECT', { infer: true }),
            location: config.get('GEMINI_LOCATION', { infer: true }),
            httpOptions: { timeout: REQUEST_TIMEOUT_MS },
        })
    }

    async review({
        videoUri,
        mimeType,
        durationS,
        rules,
        advisories,
        settings,
    }: VideoReviewRequest): Promise<VideoReview> {
        let response: GenerateContentResponse

        try {
            response = await this.client.models.generateContent({
                model: this.model,
                contents: createUserContent([
                    createPartFromUri(videoUri, mimeType),
                    buildReviewPrompt(settings, rules, advisories),
                ]),
                config: {
                    responseMimeType: 'application/json',
                    responseJsonSchema: buildReviewOutputJsonSchema(durationS),
                    maxOutputTokens: MAX_OUTPUT_TOKENS,
                },
            })
        } catch (err) {
            throw toReviewError(err)
        }

        const finishReason = response.candidates?.[0]?.finishReason
        const usage = toUsage(response.usageMetadata)

        // Every answer is billed. A cut-off one comes from the prompt and video, not chance (the whole-second
        // timestamps stopped the runaways), so another attempt would most likely pay for the same cut-off answer.
        if (finishReason === FinishReason.MAX_TOKENS) {
            throw new ModelAnswerError('The model output was cut off at the token limit', usage)
        }

        // Blocked or refused content won't change on a retry.
        if (finishReason && finishReason !== FinishReason.STOP) {
            throw new ModelAnswerError(`The model stopped early: ${finishReason}`, usage)
        }

        let output: ReviewOutput

        try {
            output = parseReviewOutput(response.text)
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)

            // Generation is stochastic: a malformed answer is usually followed by a well-formed one.
            throw new ModelAnswerError(`The model returned malformed output: ${reason}`, usage, true, { cause: err })
        }

        return {
            model: this.model,
            promptVersion: PROMPT_VERSION,
            transcript: output.transcript,
            findings: output.findings,
            advisoryIds: output.advisoryIds,
            usage,
        }
    }
}
