import type { AnalysisSettings } from 'adlens-shared'

const isSameSet = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value) => b.includes(value))

// The rule a run is counted by: the same values in each field, in any order.
export const isSameSettings = (a: AnalysisSettings, b: AnalysisSettings): boolean =>
    isSameSet(a.platforms, b.platforms) && isSameSet(a.placements, b.placements) && isSameSet(a.markets, b.markets)
