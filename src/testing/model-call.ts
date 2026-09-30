import type { ModelCall, TokenUsage } from '../database/job.doc'

export const buildModelCall = (overrides: Partial<ModelCall> = {}): ModelCall => ({
    at: new Date('2026-09-30T12:00:00.000Z'),
    model: 'fake-model',
    location: 'global',
    trafficType: 'ON_DEMAND',
    finishReason: 'STOP',
    promptTokens: 20000,
    cachedTokens: 0,
    toolUsePromptTokens: 0,
    candidatesTokens: 300,
    thoughtsTokens: 500,
    totalTokens: 20800,
    promptTokensByModality: { TEXT: 16000, VIDEO: 4000 },
    cachedTokensByModality: {},
    candidatesTokensByModality: { TEXT: 300 },
    toolUsePromptTokensByModality: {},
    ...overrides,
})

// What a job records after these calls: each call, and totals across them.
export const usageOf = (...calls: ModelCall[]): TokenUsage => ({
    promptTokens: calls.reduce((sum, call) => sum + call.promptTokens, 0),
    outputTokens: calls.reduce((sum, call) => sum + call.candidatesTokens + call.thoughtsTokens, 0),
    totalTokens: calls.reduce((sum, call) => sum + call.totalTokens, 0),
    calls,
})
