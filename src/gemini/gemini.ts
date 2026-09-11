import { GoogleGenAI } from '@google/genai'

// The current Gemini 3.x models are served from the multi-region `global` endpoint (not us-central1),
// so that is the default serving location. Override with GEMINI_LOCATION.
const VERTEX_LOCATION = process.env.GEMINI_LOCATION ?? 'global'

// Newest GA flash model — multimodal + structured output. Override with GEMINI_MODEL.
export const GEMINI_MODEL: string = process.env.GEMINI_MODEL ?? 'gemini-3.6-flash'

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
