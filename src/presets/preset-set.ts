import type { AnalysisSettings } from 'adlens-shared'

export const PRESET_COLLECTION = 'presets'

export interface StoredPreset {
    id: string
    name: string
    // The name lowercased: names are unique per user ignoring case.
    nameKey: string
    settings: AnalysisSettings
    usageCount: number
    lastUsedAt: Date | null
    createdAt: Date
    updatedAt: Date
}

// One document per user, keyed by the user id, so the limit and the unique name can each be enforced by one
// conditional update on it.
export interface PresetSetDoc {
    _id: string
    presets: StoredPreset[]
    defaultPresetId: string | null
    createdAt: Date
    updatedAt: Date
}
