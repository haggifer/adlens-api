import { type ContentListUnion, type GenerateContentConfig, GoogleGenAI } from '@google/genai'
import type { AiModel, AiModelOptions, AiRequest, AiResponse } from './types'

const VERTEX_LOCATION = process.env.GEMINI_LOCATION ?? 'global'

// Newest GA flash model — multimodal + structured output. Override with GEMINI_MODEL.
export const GEMINI_MODEL: string = process.env.GEMINI_MODEL ?? 'gemini-3.6-flash'

let client: GoogleGenAI | null = null

// Vertex mode authenticates via ADC and reads gs:// URIs directly — no API key to manage.
const getClient = (): GoogleGenAI => {
    if (client) {
        return client
    }

    const project = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT
    client = new GoogleGenAI({ vertexai: true, project, location: VERTEX_LOCATION })

    return client
}

// Returns a ready-to-use model bound to a model id + sampling options. request() takes only the content
// and provider-agnostic config; the model id, temperature, and Vertex auth are baked in here.
export const getGemini = (model: string = GEMINI_MODEL, opts: AiModelOptions = {}): AiModel => ({
    model,
    async request({ contents, config }: AiRequest): Promise<AiResponse> {
        const response = await getClient().models.generateContent({
            model,
            contents: contents as ContentListUnion,
            config: { ...config, temperature: opts.temperature } as GenerateContentConfig,
        })

        return { model, text: response.text ?? '' }
    },
})
