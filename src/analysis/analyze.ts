import { createPartFromUri, createUserContent, Type } from '@google/genai'
import type { AnalysisSettings } from 'adlens-shared'
import { z } from 'zod'

import { GEMINI_MODEL, getGemini } from '../ai/gemini'
import type { ModelFinding, RuleProjection } from '../rules'

const modelOutputSchema = z.object({
    transcript: z.string(),
    findings: z.array(
        z.object({
            id: z.string(),
            verdict: z.enum(['fail', 'warning', 'unknown']),
            evidence: z.string(),
            timestamp: z.string().optional(),
        }),
    ),
})

// Structured-output contract handed to Gemini so the reply parses without prose scraping.
const responseSchema = {
    type: Type.OBJECT,
    properties: {
        transcript: { type: Type.STRING },
        findings: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    id: { type: Type.STRING },
                    verdict: { type: Type.STRING, enum: ['fail', 'warning', 'unknown'] },
                    evidence: { type: Type.STRING },
                    timestamp: { type: Type.STRING },
                },
                required: ['id', 'verdict', 'evidence'],
            },
        },
    },
    required: ['transcript', 'findings'],
}

const buildPrompt = (settings: AnalysisSettings, rules: RuleProjection[]): string => {
    const context = [
        `Platforms: ${settings.platform.join(', ') || 'unspecified'}`,
        `Objective: ${settings.objective}`,
        settings.brand ? `Brand: ${settings.brand}` : null,
        settings.audience ? `Audience: ${settings.audience}` : null,
        settings.focus.length ? `Focus areas: ${settings.focus.join(', ')}` : null,
    ]
        .filter(Boolean)
        .join('\n')

    return [
        'You are an ad-policy compliance reviewer. Watch and listen to the attached video advertisement and evaluate it against the policy rules below.',
        '',
        'Campaign context:',
        context,
        '',
        'Rules (JSON array; each has id, check, severity, modality):',
        JSON.stringify(rules),
        '',
        'Instructions:',
        '- Return a verbatim transcript of all spoken audio (empty string if there is no speech).',
        '- Evaluate every rule against what the video actually shows and says.',
        '- Return a finding ONLY for rules the ad likely violates (verdict "fail") or where you cannot be sure (verdict "warning" for a probable issue, "unknown" when the video is inconclusive). Omit rules the ad clearly complies with.',
        '- For each finding, cite concrete evidence from the video and, when visible, an approximate timestamp or range (e.g. "0:03-0:07").',
        '- Use each rule id exactly as given; never invent ids.',
    ].join('\n')
}

export interface AnalyzeArgs {
    gcsUri: string
    mimeType: string
    contentRules: RuleProjection[]
    settings: AnalysisSettings
}

export interface AnalyzeResult {
    model: string
    transcript: string
    modelFindings: ModelFinding[]
}

// One multimodal pass that both transcribes and evaluates the content rules. Vertex reads the gs://
// URI directly (ADC auth), so there is no upload/download step for the model.
export const analyzeVideo = async ({ gcsUri, mimeType, contentRules, settings }: AnalyzeArgs): Promise<AnalyzeResult> => {
    const aiModel = getGemini(GEMINI_MODEL, { temperature: 0.2 })

    const response = await aiModel.request({
        contents: createUserContent([createPartFromUri(gcsUri, mimeType), buildPrompt(settings, contentRules)]),
        config: { responseMimeType: 'application/json', responseSchema },
    })

    const parsed = modelOutputSchema.parse(JSON.parse(response.text || '{}'))

    return { model: response.model, transcript: parsed.transcript, modelFindings: parsed.findings }
}
