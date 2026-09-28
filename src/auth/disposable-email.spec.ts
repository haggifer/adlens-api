import { isDisposableEmail } from './disposable-email'

describe('isDisposableEmail', () => {
    it('flags throwaway domains and their subdomains, in any case', () => {
        expect(isDisposableEmail('someone@mailinator.com')).toBe(true)
        expect(isDisposableEmail('someone@inbox.Mailinator.com')).toBe(true)
        expect(isDisposableEmail('SOMEONE@YOPMAIL.COM')).toBe(true)
    })

    it('lets ordinary providers through', () => {
        expect(isDisposableEmail('someone@gmail.com')).toBe(false)
        expect(isDisposableEmail('someone@proton.me')).toBe(false)
        expect(isDisposableEmail('someone@example.com')).toBe(false)
    })

    it("never flags Better Auth's placeholder address for anonymous users", () => {
        expect(isDisposableEmail('abc123@anonymous.placeholder.invalid')).toBe(false)
    })
})
