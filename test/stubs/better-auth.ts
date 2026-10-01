// Jest can't load Better Auth's ESM build; the e2e suite replaces the auth providers anyway, so these stubs only
// satisfy the imports.
export const betterAuth = () => ({})
export const mongodbAdapter = () => ({})
export const fromNodeHeaders = (headers: unknown) => headers
export const toNodeHandler = () => () => undefined
