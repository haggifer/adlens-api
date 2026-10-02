const DUPLICATE_KEY = 11000

export const isDuplicateKeyError = (err: unknown): boolean => (err as { code?: unknown })?.code === DUPLICATE_KEY
