import { GoogleGenAI } from '@google/genai'

// Vertex region — model availability is region-specific, so it's set explicitly
// rather than derived from the Firebase project's location.
const VERTEX_LOCATION = 'us-central1'

// Verify availability for your project/region; preview ids in particular can change.
export const GEMINI_MODELS = {
    pro: 'gemini-3.1-pro-preview', // deepest multimodal understanding — structural analysis
    flash: 'gemini-3.7-flash', // capable + fast multimodal — default for transcription
    flashLite: 'gemini-3.5-flash-lite', // cheapest GA — high-volume / simple passes
} as const

export type GeminiModel = (typeof GEMINI_MODELS)[keyof typeof GEMINI_MODELS]

export const DEFAULT_MODEL: GeminiModel = GEMINI_MODELS.flash

let client: GoogleGenAI | null = null

// Vertex mode authenticates via ADC and reads gs:// URIs directly.
export const getGemini = (): GoogleGenAI => {
    if (client) {
        return client
    }

    const project = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT
    client = new GoogleGenAI({ vertexai: true, project, location: VERTEX_LOCATION })

    return client
}
