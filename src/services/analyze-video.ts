import { createPartFromUri, createUserContent } from '@google/genai'

import { DEFAULT_MODEL, getGemini, type GeminiModel } from '@/lib/gemini'

interface TranscribeArgs {
    gcsUri: string
    mimeType: string
    model?: GeminiModel
}

const TRANSCRIBE_PROMPT =
    'Transcribe the spoken audio in this video ad verbatim. Return plain text only, with no commentary.'

export const transcribeVideo = async ({ gcsUri, mimeType, model = DEFAULT_MODEL }: TranscribeArgs): Promise<string> => {
    const ai = getGemini()

    const response = await ai.models.generateContent({
        model,
        contents: createUserContent([createPartFromUri(gcsUri, mimeType), TRANSCRIBE_PROMPT]),
    })

    return response.text ?? ''
}
