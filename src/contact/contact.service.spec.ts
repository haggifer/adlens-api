import type { Model } from 'mongoose'
import type { ChallengeVerifier } from '../challenge/challenge-verifier'
import type { ContactDraftDoc } from '../database/contact-draft.doc'
import type { ClientNetworkResolver } from '../ip-quota/client-network.resolver'
import type { Mailer } from '../mail/mailer'
import type { StorageService } from '../storage/storage.service'
import { configStub } from '../testing/config-stub'
import type { ContactLimits } from './contact-limits'
import type { ContactSenderReader } from './contact-sender'
import { ContactService } from './contact.service'

// The real module loads Better Auth, which is ESM-only and can't run under Jest; the sender reader isn't used here.
jest.mock('../auth/auth.service', () => ({ AuthService: class AuthService {} }))

describe('ContactService', () => {
    it('refuses to start without a CONTACT_EMAIL, so the API never runs a form with nowhere to send', () => {
        const build = () =>
            new ContactService(
                {} as Model<ContactDraftDoc>,
                {} as ContactLimits,
                {} as ClientNetworkResolver,
                {} as ChallengeVerifier,
                {} as StorageService,
                {} as Mailer,
                configStub({}),
                {} as ContactSenderReader,
            )

        expect(build).toThrow('CONTACT_EMAIL is required')
    })
})
