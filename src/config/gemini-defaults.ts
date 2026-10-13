// What production calls when GEMINI_MODEL and GEMINI_LOCATION are unset. A module of its own, without env.ts's
// validation on import, so the lab (adlens-lab) can read the same defaults.
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash'
export const DEFAULT_GEMINI_LOCATION = 'global'
