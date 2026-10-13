import { ApiError, type GenerateContentResponse, GoogleGenAI } from '@google/genai'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { describeError } from '../../common/error-message'
import type { Env } from '../../config/env'
import { ModelCallRefusedError } from '../pipeline/model-answer-error'
import { RetryableError } from '../pipeline/retryable-error'
import {
    buildReviewConfig,
    buildReviewContents,
    GEMINI_REQUEST_TIMEOUT_MS,
    isRetryableStatus,
    readReview,
} from './gemini-review'
import { type VideoReview, VideoReviewer, type VideoReviewRequest } from './video-reviewer'

interface TimedResponse {
    response: GenerateContentResponse
    durationMs: number
}

const getElapsedMs = (startedAt: number) => Math.round(performance.now() - startedAt)

// The elapsed time goes into the message, which the pipeline logs, to tell a timeout from a fast failure.
const toReviewError = (err: unknown, elapsedMs: number): Error => {
    const detail = `${describeError(err)} (after ${elapsedMs} ms)`
    // The SDK throws ApiError only for a response with an error status; a timeout or a network failure is anything
    // else.
    const refused = err instanceof ApiError ? new ModelCallRefusedError(detail, err.status, { cause: err }) : null

    if (refused && !isRetryableStatus(refused.status)) {
        return refused
    }

    // Provider overload, timeouts and network failures.
    return new RetryableError(detail, { cause: refused ?? err })
}

// Gemini on Vertex AI: authenticates with ADC and reads the video straight from its gs:// URI. The request and how
// its answer is read live in gemini-review.ts, which the lab shares.
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
            httpOptions: { timeout: GEMINI_REQUEST_TIMEOUT_MS },
        })
    }

    async review(request: VideoReviewRequest): Promise<VideoReview> {
        const { response, durationMs } = await this.generate(request)

        return readReview(response, { model: this.model, location: this.location, at: new Date(), durationMs })
    }

    private async generate(request: VideoReviewRequest): Promise<TimedResponse> {
        // Built before the clock starts, so the duration is the model request alone.
        const contents = buildReviewContents(request)
        const config = buildReviewConfig(request)

        const startedAt = performance.now()

        try {
            const response = await this.client.models.generateContent({ model: this.model, contents, config })

            return { response, durationMs: getElapsedMs(startedAt) }
        } catch (err) {
            throw toReviewError(err, getElapsedMs(startedAt))
        }
    }
}
