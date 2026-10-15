import type { AnalysisSettings } from 'adlens-shared'

// A user's saved presets, all in one document (presets.service.ts reads and writes it).
export const USER_PRESETS_COLLECTION = 'user_presets'

export interface StoredPreset {
    id: string
    name: string
    // The name as compared (presets.service.ts toNameKey): names are unique per user ignoring case, inner whitespace
    // and Unicode compatibility forms.
    nameKey: string
    settings: AnalysisSettings
    usageCount: number
    lastUsedAt: Date | null
    createdAt: Date
    updatedAt: Date
}

// One document per user, so the limit and the unique name can each be enforced by one conditional update on it.
export interface UserPresetsDoc {
    // The owner's user id (a string; Better Auth's `user._id` is the same value as an ObjectId).
    _id: string
    presets: StoredPreset[]
    defaultPresetId: string | null
    createdAt: Date
    updatedAt: Date
}
