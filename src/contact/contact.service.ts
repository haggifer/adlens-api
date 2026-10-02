import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectModel } from '@nestjs/mongoose'
import {
    type CreateContactUploadsInput,
    type CreateContactUploadsResponse,
    RequestErrorCode,
    type SendContactMessagePayload,
} from 'adlens-shared'
import { Model } from 'mongoose'
import { randomUUID } from 'node:crypto'
import { challengeFailed, ChallengeVerifier } from '../challenge/challenge-verifier'
import { ApiException } from '../common/api-exception'
import { describeError } from '../common/error-message'
import type { Env } from '../config/env'
import { CONTACT_DRAFT_MODEL, type ContactDraftDoc, type ContactDraftFile } from '../database/contact-draft.doc'
import type { IpSource } from '../ip-quota/client-ip'
import { ClientNetworkResolver } from '../ip-quota/client-network.resolver'
import { type MailAttachment, Mailer } from '../mail/mailer'
import { type ObjectContent, StorageService } from '../storage/storage.service'
import { attachmentFilename, contactAttachmentPath } from './contact-attachments'
import { contactEmail } from './contact-email'
import { ContactLimits } from './contact-limits'

// Long enough to upload five images on a slow connection and finish writing; the signed URLs expire sooner.
const DRAFT_TTL_MS = 60 * 60 * 1000

const unavailable = (message: string) =>
    new ApiException(HttpStatus.SERVICE_UNAVAILABLE, RequestErrorCode.Unavailable, message)

const invalidDraft = (message: string) =>
    new ApiException(HttpStatus.BAD_REQUEST, RequestErrorCode.ValidationFailed, message)

const rateLimited = () =>
    new ApiException(HttpStatus.TOO_MANY_REQUESTS, RequestErrorCode.RateLimited, 'Too many messages')

@Injectable()
export class ContactService {
    private readonly logger = new Logger(ContactService.name)

    constructor(
        @InjectModel(CONTACT_DRAFT_MODEL) private readonly drafts: Model<ContactDraftDoc>,
        private readonly limits: ContactLimits,
        private readonly network: ClientNetworkResolver,
        private readonly challenge: ChallengeVerifier,
        private readonly storage: StorageService,
        private readonly mailer: Mailer,
        private readonly config: ConfigService<Env, true>,
    ) {}

    // A draft and one signed, create-only upload per declared image; the message then sends the draft id instead of
    // a second Turnstile token.
    async createUploads(input: CreateContactUploadsInput, ipSource: IpSource): Promise<CreateContactUploadsResponse> {
        this.getRecipient()

        const { ip, bucketKey } = this.network.resolve(ipSource)

        await this.verifyChallenge(input.challengeToken, ip)

        const isAllowed = await this.limits.allowUploads(bucketKey)

        if (!isAllowed) {
            throw rateLimited()
        }

        const draftId = randomUUID()
        const files = input.files.map(({ name, contentType, size }, index) => ({
            path: contactAttachmentPath(draftId, index, contentType),
            name,
            contentType,
            size,
        }))

        await this.drafts.create({ _id: draftId, files, expiresAt: new Date(Date.now() + DRAFT_TTL_MS), usedAt: null })

        const uploads = await Promise.all(
            files.map(({ path, contentType, size }) => this.storage.createUploadTarget(path, contentType, size)),
        )

        return { draftId, uploads }
    }

    async send(input: SendContactMessagePayload, ipSource: IpSource): Promise<void> {
        // A bot filled in the hidden field: answer as if it worked, so it learns nothing.
        if (input.website) {
            this.logger.warn('dropped a contact message that filled in the honeypot')
            return
        }

        const to = this.getRecipient()
        const { ip, bucketKey } = this.network.resolve(ipSource)
        // Before the caps, so requests without a passed check can't use them up.
        const files = await this.admit(input, ip)
        // Also before the caps: a refused upload must not cost the sender a message.
        const attachments = await this.readAttachments(files)
        const email = input.email.toLowerCase()
        const isAllowed = await this.limits.allowMessage(bucketKey, email)

        if (!isAllowed) {
            throw rateLimited()
        }

        try {
            await this.mailer.send(contactEmail(to, { ...input, email }, attachments))
        } catch (err) {
            this.logger.error(`could not send a contact message: ${describeError(err)}`)
            throw unavailable('The message could not be sent')
        }
    }

    private getRecipient(): string {
        const to = this.config.get('CONTACT_EMAIL', { infer: true })

        if (!to) {
            throw unavailable('Contact is not set up')
        }

        return to
    }

    private async verifyChallenge(token: string | undefined, ip: string | null): Promise<void> {
        if (!token) {
            throw challengeFailed()
        }

        const isHuman = await this.challenge.verify(token, ip)

        if (!isHuman) {
            throw challengeFailed()
        }
    }

    // A draft passes once, in place of the check: only the request that marks it used gets its images.
    private async admit(input: SendContactMessagePayload, ip: string | null): Promise<ContactDraftFile[]> {
        if (!input.draftId) {
            await this.verifyChallenge(input.challengeToken, ip)
            return []
        }

        const now = new Date()
        const draft = await this.drafts
            .findOneAndUpdate(
                { _id: input.draftId, usedAt: null, expiresAt: { $gt: now } },
                { $set: { usedAt: now } },
                { new: true },
            )
            .lean()

        if (!draft) {
            throw invalidDraft('Unknown, used or expired draft')
        }

        return draft.files
    }

    private async readAttachments(files: ContactDraftFile[]): Promise<MailAttachment[]> {
        let objects: (ObjectContent | null)[]

        try {
            objects = await Promise.all(files.map((file) => this.storage.readObject(file.path)))
        } catch (err) {
            this.logger.error(`could not read a contact attachment: ${describeError(err)}`)
            throw unavailable('The message could not be sent')
        }

        return files.map((file, index) => {
            const object = objects[index]

            if (!object || object.contentType !== file.contentType || object.content.length !== file.size) {
                throw invalidDraft('An image is missing or differs from the one declared')
            }

            return { filename: attachmentFilename(file.name, file.contentType), content: object.content }
        })
    }
}
