import { FinishReason, MediaModality, TrafficType } from '@google/genai'
import { toModelCall } from './model-call'

const AT = new Date('2026-09-30T12:00:00.000Z')
const WHERE = { model: 'gemini-3.8-flash', location: 'global', at: AT, durationMs: 41250 }

describe('toModelCall', () => {
    it('keeps everything a price depends on (model, endpoint, time, traffic type, every token count) and the duration', () => {
        const call = toModelCall(
            {
                promptTokenCount: 12000,
                cachedContentTokenCount: 500,
                toolUsePromptTokenCount: 0,
                candidatesTokenCount: 600,
                thoughtsTokenCount: 900,
                totalTokenCount: 13500,
                trafficType: TrafficType.ON_DEMAND,
                promptTokensDetails: [
                    { modality: MediaModality.TEXT, tokenCount: 7000 },
                    { modality: MediaModality.VIDEO, tokenCount: 3500 },
                    { modality: MediaModality.AUDIO, tokenCount: 1500 },
                ],
                cacheTokensDetails: [{ modality: MediaModality.TEXT, tokenCount: 500 }],
                candidatesTokensDetails: [{ modality: MediaModality.TEXT, tokenCount: 600 }],
            },
            FinishReason.STOP,
            WHERE,
        )

        expect(call).toEqual({
            at: AT,
            durationMs: 41250,
            model: 'gemini-3.8-flash',
            location: 'global',
            trafficType: 'ON_DEMAND',
            finishReason: 'STOP',
            promptTokens: 12000,
            cachedTokens: 500,
            toolUsePromptTokens: 0,
            candidatesTokens: 600,
            thoughtsTokens: 900,
            totalTokens: 13500,
            promptTokensByModality: { TEXT: 7000, VIDEO: 3500, AUDIO: 1500 },
            cachedTokensByModality: { TEXT: 500 },
            candidatesTokensByModality: { TEXT: 600 },
            toolUsePromptTokensByModality: {},
        })
    })

    it('records zeros and no modalities when the response has no usage', () => {
        const call = toModelCall(undefined, undefined, WHERE)

        expect(call).not.toHaveProperty('trafficType')
        expect(call).not.toHaveProperty('finishReason')
        expect(call).toMatchObject({
            promptTokens: 0,
            thoughtsTokens: 0,
            totalTokens: 0,
            promptTokensByModality: {},
        })
    })
})
