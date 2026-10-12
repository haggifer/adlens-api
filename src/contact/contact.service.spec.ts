import { HttpStatus } from '@nestjs/common'
import { RequestErrorCode } from 'adlens-shared'
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

const IP_SOURCE = { forwardedFor: '192.0.2.1', socketAddress: undefined }

describe('ContactService without a CONTACT_EMAIL', () => {
    const verify = jest.fn()
    const allowUploads = jest.fn()
    const allowMessage = jest.fn()
    const send = jest.fn()
    const service = new ContactService(
        {} as Model<ContactDraftDoc>,
        { allowUploads, allowMessage } as unknown as ContactLimits,
        { resolve: () => ({ ip: '192.0.2.1', bucketKey: 'network-key' }) } as unknown as ClientNetworkResolver,
        { verify } as unknown as ChallengeVerifier,
        {} as StorageService,
        { send } as unknown as Mailer,
        configStub({}),
        {} as ContactSenderReader,
    )

    const expectUnavailable = async (request: Promise<unknown>) => {
        await expect(request).rejects.toMatchObject({
            status: HttpStatus.SERVICE_UNAVAILABLE,
            response: { errorCode: RequestErrorCode.Unavailable },
        })
        expect(verify).not.toHaveBeenCalled()
        expect(allowUploads).not.toHaveBeenCalled()
        expect(allowMessage).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
    }

    it('answers 503 to an upload request before checking or counting it', async () => {
        await expectUnavailable(
            service.createUploads(
                { files: [{ name: 'shot.png', contentType: 'image/png', size: 100 }], challengeToken: 'pass' },
                IP_SOURCE,
            ),
        )
    })

    it('answers 503 to a message before checking or counting it', async () => {
        await expectUnavailable(
            service.send(
                { email: 'visitor@example.com', message: 'Hello there', challengeToken: 'pass' },
                IP_SOURCE,
                {},
            ),
        )
    })
})
