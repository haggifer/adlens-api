// A ready-to-use model handle. Each provider factory (getGemini, later getClaude/getChatGPT) returns
// this shape, so callers issue requests the same way regardless of provider — provider-specific setup
// (model id, sampling, auth) is baked into the factory, and request() carries only content + config.
export interface AiRequestConfig {
    responseMimeType?: string
    responseSchema?: unknown
}

export interface AiRequest {
    contents: unknown
    config?: AiRequestConfig
}

export interface AiResponse {
    model: string
    text: string
}

export interface AiModel {
    readonly model: string
    request(req: AiRequest): Promise<AiResponse>
}

export interface AiModelOptions {
    temperature?: number
}
