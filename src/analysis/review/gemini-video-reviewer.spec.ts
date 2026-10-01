import { BlockedReason, FinishReason, type GenerateContentResponse } from '@google/genai'
import { configStub } from '../../testing/config-stub'
import { ModelAnswerError } from '../pipeline/model-answer-error'
import { isRetryable } from '../pipeline/retryable-error'
import { GeminiVideoReviewer } from './gemini-video-reviewer'
import type { VideoReviewRequest } from './video-reviewer'

const REQUEST: VideoReviewRequest = {
    videoUri: 'gs://bucket/users/u1/jobs/j1/video',
    mimeType: 'video/mp4',
    durationS: 15,
    rules: [],
    advisories: [],
    settings: { platforms: [], placements: [], markets: [] },
}

const USAGE = { promptTokenCount: 20000, candidatesTokenCount: 10, totalTokenCount: 20010 }

const answer = (text: string, finishReason = FinishReason.STOP) =>
    ({
        candidates: [{ finishReason, content: { parts: [{ text }] } }],
        text,
        usageMetadata: USAGE,
    }) as unknown as GenerateContentResponse

describe('GeminiVideoReviewer', () => {
    const generateContent = jest.fn<Promise<GenerateContentResponse>, unknown[]>()

    const build = () => {
        const reviewer = new GeminiVideoReviewer(
            configStub({ GEMINI_MODEL: 'fake-model', GEMINI_LOCATION: 'global', GOOGLE_CLOUD_PROJECT: 'p' }),
        )

        // Never the real client: tests make no model calls.
        Object.assign(reviewer, { client: { models: { generateContent } } })

        return reviewer
    }

    const reviewError = async () => {
        try {
            await build().review(REQUEST)
        } catch (err) {
            return err
        }

        throw new Error('expected the review to fail')
    }

    beforeEach(() => generateContent.mockReset())

    it('fails a blocked prompt without a retry, keeping the call it was billed for', async () => {
        generateContent.mockResolvedValue({
            promptFeedback: { blockReason: BlockedReason.SAFETY },
            usageMetadata: USAGE,
        } as unknown as GenerateContentResponse)

        const err = await reviewError()

        expect(err).toBeInstanceOf(ModelAnswerError)
        expect((err as ModelAnswerError).message).toContain('SAFETY')
        expect((err as ModelAnswerError).call.promptTokens).toBe(20000)
        expect(isRetryable(err)).toBe(false)
    })

    it('fails an answer without candidates without a retry', async () => {
        generateContent.mockResolvedValue({
            candidates: [],
            usageMetadata: USAGE,
        } as unknown as GenerateContentResponse)

        const err = await reviewError()

        expect(err).toBeInstanceOf(ModelAnswerError)
        expect(isRetryable(err)).toBe(false)
    })

    it('fails a malformed answer without a retry, since another attempt would be billed again', async () => {
        generateContent.mockResolvedValue(answer('{"transcript": '))

        const err = await reviewError()

        expect(err).toBeInstanceOf(ModelAnswerError)
        expect(isRetryable(err)).toBe(false)
    })

    it('leaves a provider error without an answer to a retry', async () => {
        generateContent.mockRejectedValue(new Error('fetch failed'))

        const err = await reviewError()

        expect(err).not.toBeInstanceOf(ModelAnswerError)
        expect(isRetryable(err)).toBe(true)
    })
})
