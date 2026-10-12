import { buildMailboxPattern } from './email-alias'

describe('buildMailboxPattern', () => {
    it.each([
        ['ann@gmail.com', 'ann@gmail.com'],
        ['ann+adlens@gmail.com', 'ann@gmail.com'],
        ['ann@gmail.com', 'ann+2@gmail.com'],
        ['a.n.n@gmail.com', 'ann@gmail.com'],
        ['ann@gmail.com', 'a.nn+x@googlemail.com'],
        ['  Ann+Tag@Gmail.com ', 'ann@gmail.com'],
        ['ann+1@outlook.com', 'ann+2@outlook.com'],
        ['ann@company.com', 'ann+news@company.com'],
    ])('treats %s and %s as one mailbox', (signUp, stored) => {
        expect(buildMailboxPattern(signUp).test(stored)).toBe(true)
    })

    it.each([
        ['ann@gmail.com', 'anna@gmail.com'],
        ['ann@gmail.com', 'ann@gmail.co'],
        ['ann@gmail.com', 'xann@gmail.com'],
        // Only Gmail ignores dots.
        ['a.nn@outlook.com', 'ann@outlook.com'],
        ['ann@outlook.com', 'ann@outlook.com.evil.test'],
        ['ann@company.com', 'ann@other.com'],
    ])('keeps %s and %s apart', (signUp, stored) => {
        expect(buildMailboxPattern(signUp).test(stored)).toBe(false)
    })

    it('reads regex characters in an address literally', () => {
        expect(buildMailboxPattern('a.b*c@x.com').test('a.b*c@x.com')).toBe(true)
        expect(buildMailboxPattern('a.b*c@x.com').test('aXbbbc@x.com')).toBe(false)
    })
})
