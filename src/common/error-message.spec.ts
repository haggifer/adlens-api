import { describeError, describeErrorWithStack } from './error-message'

describe('describeError', () => {
    it("gives an Error's message", () => {
        expect(describeError(new Error('boom'))).toBe('boom')
    })

    it('gives anything else as a string', () => {
        expect(describeError('boom')).toBe('boom')
        expect(describeError(42)).toBe('42')
        expect(describeError(undefined)).toBe('undefined')
    })
})

describe('describeErrorWithStack', () => {
    it("gives an Error's stack", () => {
        const err = new Error('boom')

        expect(describeErrorWithStack(err)).toBe(err.stack)
    })

    it("falls back to the message when there's no stack", () => {
        const err = new Error('boom')

        err.stack = undefined

        expect(describeErrorWithStack(err)).toBe('boom')
    })

    it('gives anything else as a string', () => {
        expect(describeErrorWithStack('boom')).toBe('boom')
    })
})
