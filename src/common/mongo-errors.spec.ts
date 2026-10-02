import { isDuplicateKeyError } from './mongo-errors'

describe('isDuplicateKeyError', () => {
    it("matches MongoDB's duplicate-key code", () => {
        expect(isDuplicateKeyError(Object.assign(new Error('E11000'), { code: 11000 }))).toBe(true)
    })

    it('rejects other errors and values', () => {
        expect(isDuplicateKeyError(Object.assign(new Error('other'), { code: 112 }))).toBe(false)
        expect(isDuplicateKeyError(new Error('no code'))).toBe(false)
        expect(isDuplicateKeyError(null)).toBe(false)
        expect(isDuplicateKeyError(undefined)).toBe(false)
    })
})
