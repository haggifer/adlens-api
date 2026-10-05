import type { FinishReason, GenerateContentResponseUsageMetadata, ModalityTokenCount } from '@google/genai'
import type { ModelCall } from '../../database/job.doc'

interface CallContext {
    model: string
    location: string
    at: Date
    durationMs: number
}

const byModality = (details: ModalityTokenCount[] | undefined): Record<string, number> =>
    Object.fromEntries(
        (details ?? []).flatMap(({ modality, tokenCount }) => (modality ? [[modality, tokenCount ?? 0]] : [])),
    )

// A billed call as the job records it, from the response's usage metadata.
export const toModelCall = (
    usage: GenerateContentResponseUsageMetadata | undefined,
    finishReason: FinishReason | undefined,
    { model, location, at, durationMs }: CallContext,
): ModelCall => ({
    at,
    durationMs,
    model,
    location,
    // Left out rather than undefined, which the database would store as null.
    ...(usage?.trafficType ? { trafficType: usage.trafficType } : {}),
    ...(finishReason ? { finishReason } : {}),
    promptTokens: usage?.promptTokenCount ?? 0,
    cachedTokens: usage?.cachedContentTokenCount ?? 0,
    toolUsePromptTokens: usage?.toolUsePromptTokenCount ?? 0,
    candidatesTokens: usage?.candidatesTokenCount ?? 0,
    thoughtsTokens: usage?.thoughtsTokenCount ?? 0,
    totalTokens: usage?.totalTokenCount ?? 0,
    promptTokensByModality: byModality(usage?.promptTokensDetails),
    cachedTokensByModality: byModality(usage?.cacheTokensDetails),
    candidatesTokensByModality: byModality(usage?.candidatesTokensDetails),
    toolUsePromptTokensByModality: byModality(usage?.toolUsePromptTokensDetails),
})
