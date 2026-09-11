import { GoogleGenAI } from '@google/genai'

// Vertex region — model availability is region-specific, so it's set explicitly
// rather than derived from the Firebase project's location.
const VERTEX_LOCATION = 'us-central1'

// Verify availability for your project/region; ids can change. Override the active one with GEMINI_MODEL.
export const GEMINI_MODELS = {
    pro: 'gemini-2.5-pro', // deepest multimodal understanding — structural analysis
    flash: 'gemini-2.5-flash', // capable + fast multimodal — default
    flashLite: 'gemini-2.5-flash-lite', // cheapest — high-volume / simple passes
} as const

export type GeminiModel = (typeof GEMINI_MODELS)[keyof typeof GEMINI_MODELS]

export const DEFAULT_MODEL: GeminiModel = GEMINI_MODELS.flash

export const GEMINI_MODEL: string = process.env.GEMINI_MODEL ?? DEFAULT_MODEL

let client: GoogleGenAI | null = null

// Vertex mode authenticates via ADC and reads gs:// URIs directly — no API key to manage.
export const getGemini = (): GoogleGenAI => {
    if (client) {
        return client
    }

    const project = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT
    client = new GoogleGenAI({ vertexai: true, project, location: VERTEX_LOCATION })

    return client
}
