export const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export const describeErrorWithStack = (err: unknown): string =>
    err instanceof Error ? (err.stack ?? err.message) : String(err)
