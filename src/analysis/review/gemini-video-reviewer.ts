import {
    ApiError,
    type Content,
    createPartFromUri,
    createUserContent,
    FinishReason,
    type GenerateContentResponse,
    GoogleGenAI,
} from '@google/genai'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { describeError } from '../../common/error-message'
import type { Env } from '../../config/env'
import type { ModelCall } from '../../database/job.doc'
import { ModelAnswerError, ModelCallRefusedError } from '../pipeline/model-answer-error'
import { RetryableError } from '../pipeline/retryable-error'
import { toModelCall } from './model-call'
import {
    buildReviewOutputJsonSchema,
    buildReviewPrompt,
    parseReviewOutput,
    PROMPT_VERSION,
    type ReviewOutput,
} from './review-prompt'
import { type VideoReview, VideoReviewer, type VideoReviewRequest } from './video-reviewer'

interface TimedResponse {
    response: GenerateContentResponse
    durationMs: number
}

// Well under the Cloud Run task timeout (15 min), so a hung call ends in a handled failure, not a killed task.
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000

// A full answer for ~60 rules and a 60-second transcript is a few thousand tokens; the cap bounds what a runaway
// generation can cost per attempt.
const MAX_OUTPUT_TOKENS = 8192

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])

const getElapsedMs = (startedAt: number) => Math.round(performance.now() - startedAt)

// The elapsed time goes into the message, which the pipeline logs, to tell a timeout from a fast failure.
const toReviewError = (err: unknown, elapsedMs: number): Error => {
    const detail = `${describeError(err)} (after ${elapsedMs} ms)`
    // The SDK throws ApiError only for a response with an error status; a timeout or a network failure is anything
    // else.
    const refused = err instanceof ApiError ? new ModelCallRefusedError(detail, err.status, { cause: err }) : null

    if (refused && !RETRYABLE_STATUSES.has(refused.status)) {
        return refused
    }

    // Provider overload, timeouts and network failures.
    return new RetryableError(detail, { cause: refused ?? err })
}

// The prompt goes first: Vertex's implicit cache matches a request's prefix, and the video differs in every request.
export const buildReviewContents = (prompt: string, videoUri: string, mimeType: string): Content =>
    createUserContent([prompt, createPartFromUri(videoUri, mimeType)])

const parseAnswer = (text: string | undefined, call: ModelCall): ReviewOutput => {
    try {
        return parseReviewOutput(text)
    } catch (err) {
        throw new ModelAnswerError(`The model returned malformed output: ${describeError(err)}`, call, { cause: err })
    }
}

// Gemini on Vertex AI: authenticates with ADC and reads the video straight from its gs:// URI. Temperature stays at the
// Gemini 3 default (1.0); Google warns that lower values can make these models loop.
@Injectable()
export class GeminiVideoReviewer extends VideoReviewer {
    private readonly client: GoogleGenAI
    private readonly model: string
    private readonly location: string

    constructor(config: ConfigService<Env, true>) {
        super()
        this.model = config.get('GEMINI_MODEL', { infer: true })
        this.location = config.get('GEMINI_LOCATION', { infer: true })
        this.client = new GoogleGenAI({
            vertexai: true,
            project: config.get('GOOGLE_CLOUD_PROJECT', { infer: true }),
            location: this.location,
            httpOptions: { timeout: REQUEST_TIMEOUT_MS },
        })
    }

    async review(request: VideoReviewRequest): Promise<VideoReview> {
        const { response, durationMs } = await this.generate(request)
        const finishReason = response.candidates?.[0]?.finishReason
        const call = toModelCall(response.usageMetadata, finishReason, {
            model: this.model,
            location: this.location,
            at: new Date(),
            durationMs,
        })

        // A blocked prompt gets no candidates. Blocked content won't change on a retry.
        const blockReason = response.promptFeedback?.blockReason

        if (blockReason || !response.candidates?.length) {
            throw new ModelAnswerError(`The prompt was blocked: ${blockReason ?? 'no candidates'}`, call)
        }

        // Every answer is billed. A cut-off one comes from the prompt and video, not chance (the whole-second
        // timestamps stopped the runaways), so another attempt would most likely pay for the same cut-off answer.
        if (finishReason === FinishReason.MAX_TOKENS) {
            throw new ModelAnswerError('The model output was cut off at the token limit', call)
        }

        // Blocked or refused content won't change on a retry.
        if (finishReason && finishReason !== FinishReason.STOP) {
            throw new ModelAnswerError(`The model stopped early: ${finishReason}`, call)
        }

        const output = parseAnswer(response.text, call)

        return {
            model: this.model,
            promptVersion: PROMPT_VERSION,
            transcript: output.transcript,
            findings: output.findings,
            advisoryIds: output.advisoryIds,
            call,
        }
    }

    private async generate({
        videoUri,
        mimeType,
        rules,
        advisories,
        settings,
    }: VideoReviewRequest): Promise<TimedResponse> {
        // Built before the clock starts, so the duration is the model request alone.
        const contents = buildReviewContents(buildReviewPrompt(settings, rules, advisories), videoUri, mimeType)
        const config = {
            responseMimeType: 'application/json',
            responseJsonSchema: buildReviewOutputJsonSchema(),
            maxOutputTokens: MAX_OUTPUT_TOKENS,
        }

        const startedAt = performance.now()

        try {
            const response = await this.client.models.generateContent({ model: this.model, contents, config })

            return { response, durationMs: getElapsedMs(startedAt) }
        } catch (err) {
            throw toReviewError(err, getElapsedMs(startedAt))
        }
    }
}
