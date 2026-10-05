import { ApiError, BlockedReason, FinishReason, type GenerateContentResponse } from '@google/genai'
import { Market } from 'adlens-shared'
import { configStub } from '../../testing/config-stub'
import { isRefusedCall, ModelAnswerError } from '../pipeline/model-answer-error'
import { isRetryable } from '../pipeline/retryable-error'
import { buildReviewContents, GeminiVideoReviewer } from './gemini-video-reviewer'
import type { VideoReviewRequest } from './video-reviewer'

const REQUEST: VideoReviewRequest = {
    videoUri: 'gs://bucket/users/u1/jobs/j1/video',
    mimeType: 'video/mp4',
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

interface SentRequest {
    contents: { parts: { text?: string; fileData?: { fileUri: string } }[] }
    config: unknown
}

describe('buildReviewContents', () => {
    // Vertex's implicit cache matches a request's prefix: a video first made every request differ from its first part.
    it('puts the prompt before the video', () => {
        expect(buildReviewContents('Review this ad.', 'gs://bucket/video', 'video/mp4')).toEqual({
            role: 'user',
            parts: [{ text: 'Review this ad.' }, { fileData: { fileUri: 'gs://bucket/video', mimeType: 'video/mp4' } }],
        })
    })
})

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

    it('sends the same prompt start and config for another video and campaign, with the video last', async () => {
        generateContent.mockResolvedValue(answer('{"transcript": [], "findings": [], "advisories": []}'))

        await build().review(REQUEST)
        await build().review({
            ...REQUEST,
            videoUri: 'gs://bucket/users/u2/jobs/j2/video',
            settings: { platforms: [], placements: [], markets: [Market.UK] },
        })

        const [first, second] = generateContent.mock.calls.map(([request]) => request as SentRequest)
        const promptStart = ({ contents }: SentRequest) => contents.parts[0].text?.split('Campaign context')[0]

        expect(promptStart(second)).toBe(promptStart(first))
        expect(second.config).toEqual(first.config)
        expect(second.contents.parts[1].fileData?.fileUri).toBe('gs://bucket/users/u2/jobs/j2/video')
    })

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

    it('reports an HTTP error status from Vertex as a refused call, retried when the status is transient', async () => {
        generateContent.mockRejectedValue(new ApiError({ message: 'overloaded', status: 503 }))

        const transient = await reviewError()

        generateContent.mockRejectedValue(new ApiError({ message: 'bad request', status: 400 }))

        const permanent = await reviewError()

        expect(isRefusedCall(transient)).toBe(true)
        expect(isRetryable(transient)).toBe(true)
        expect(isRefusedCall(permanent)).toBe(true)
        expect(isRetryable(permanent)).toBe(false)
    })

    it('never reports a timeout or a dropped connection as a refused call, since Vertex may have billed it', async () => {
        generateContent.mockRejectedValue(new DOMException('This operation was aborted', 'AbortError'))

        const timedOut = await reviewError()

        generateContent.mockRejectedValue(new TypeError('fetch failed', { cause: new Error('ECONNRESET') }))

        const dropped = await reviewError()

        expect(isRefusedCall(timedOut)).toBe(false)
        expect(isRetryable(timedOut)).toBe(true)
        expect(isRefusedCall(dropped)).toBe(false)
        expect(isRetryable(dropped)).toBe(true)
    })

    describe('call duration', () => {
        // The fake clock moves only while the model request is pending, so parsing the answer adds nothing.
        const settleAfter = (ms: number, settle: () => GenerateContentResponse) =>
            generateContent.mockImplementation(async () => {
                jest.advanceTimersByTime(ms)

                return settle()
            })

        beforeEach(() => jest.useFakeTimers())

        afterEach(() => jest.useRealTimers())

        it('records how long the model request took, in whole milliseconds', async () => {
            settleAfter(41250.6, () => answer('{"transcript": [], "findings": [], "advisories": []}'))

            const review = await build().review(REQUEST)

            expect(review.call.durationMs).toBe(41251)
        })

        it('records it on a billed answer that cannot be used', async () => {
            settleAfter(95000, () => answer('{"transcript": ', FinishReason.MAX_TOKENS))

            const err = await reviewError()

            expect(err).toBeInstanceOf(ModelAnswerError)
            expect((err as ModelAnswerError).call.durationMs).toBe(95000)
        })

        it('reports how long a call that got no answer ran', async () => {
            settleAfter(600000, () => {
                throw new DOMException('This operation was aborted', 'AbortError')
            })

            const timedOut = await reviewError()

            settleAfter(1500, () => {
                throw new ApiError({ message: 'bad request', status: 400 })
            })

            const refused = await reviewError()

            expect((timedOut as Error).message).toContain('after 600000 ms')
            expect((refused as Error).message).toContain('after 1500 ms')
        })
    })
})
