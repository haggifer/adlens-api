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
import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
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
import { ContactSenderReader } from './contact-sender'
import { ContactLimits } from './contact-limits'

// Long enough to upload five images on a slow connection and finish writing; the signed URLs expire sooner.
const DRAFT_TTL_MS = 60 * 60 * 1000

const unavailable = (message: string) =>
    new ApiException(HttpStatus.SERVICE_UNAVAILABLE, RequestErrorCode.Unavailable, message)

const invalidDraft = (message: string) =>
    new ApiException(HttpStatus.BAD_REQUEST, RequestErrorCode.ValidationFailed, message)

const rateLimited = () =>
    new ApiException(HttpStatus.TOO_MANY_REQUESTS, RequestErrorCode.RateLimited, 'Too many messages')

// The API can't start without it: a Contact form with nowhere to send to would fail every message. The worker, which
// shares the env schema, sends no email.
const readRecipient = (config: ConfigService<Env, true>): string => {
    const to = config.get('CONTACT_EMAIL', { infer: true })

    if (!to) {
        throw new Error('CONTACT_EMAIL is required: Contact form messages are sent to it')
    }

    return to
}

// "3F9A2C": short enough to say or search for, in the subject and the logs.
const createRef = (): string => randomBytes(3).toString('hex').toUpperCase()

const toDraftFiles = (draftId: string, files: CreateContactUploadsInput['files']): ContactDraftFile[] =>
    files.map(({ name, contentType, size }, index) => ({
        path: contactAttachmentPath(draftId, index, contentType),
        name,
        contentType,
        size,
    }))

@Injectable()
export class ContactService {
    private readonly logger = new Logger(ContactService.name)
    private readonly recipient: string

    constructor(
        @InjectModel(CONTACT_DRAFT_MODEL) private readonly drafts: Model<ContactDraftDoc>,
        private readonly limits: ContactLimits,
        private readonly network: ClientNetworkResolver,
        private readonly challenge: ChallengeVerifier,
        private readonly storage: StorageService,
        private readonly mailer: Mailer,
        private readonly config: ConfigService<Env, true>,
        private readonly senders: ContactSenderReader,
    ) {
        this.recipient = readRecipient(config)
    }

    // A draft and one signed, create-only upload per declared image; the message then sends the draft id instead of
    // a second Turnstile token.
    async createUploads(input: CreateContactUploadsInput, ipSource: IpSource): Promise<CreateContactUploadsResponse> {
        const { ip, bucketKey } = this.network.resolve(ipSource)

        await this.verifyChallenge(input.challengeToken, ip)

        const isAllowed = await this.limits.allowUploads(bucketKey)

        if (!isAllowed) {
            throw rateLimited()
        }

        const draftId = randomUUID()
        const files = toDraftFiles(draftId, input.files)

        await this.drafts.create({ _id: draftId, files, expiresAt: new Date(Date.now() + DRAFT_TTL_MS), usedAt: null })

        const uploads = await Promise.all(
            files.map(({ path, contentType, size }) => this.storage.createUploadTarget(path, contentType, size)),
        )

        return { draftId, uploads }
    }

    // The request's headers name the sender's session, if any, and device, for the facts under the message.
    async send(input: SendContactMessagePayload, ipSource: IpSource, headers: IncomingHttpHeaders): Promise<void> {
        // A bot filled in the hidden field: answer as if it worked, so it learns nothing.
        if (input.website) {
            this.logger.warn('dropped a contact message that filled in the honeypot')
            return
        }

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

        const sender = await this.senders.read(headers)
        const ref = createRef()
        const apiVersion = this.config.get('K_REVISION', { infer: true }) ?? null

        try {
            await this.mailer.send(
                contactEmail({
                    to: this.recipient,
                    message: { ...input, email },
                    sender,
                    ref,
                    apiVersion,
                    attachments,
                }),
            )
        } catch (err) {
            this.logger.error(`could not send contact message ${ref}: ${describeError(err)}`)
            throw unavailable('The message could not be sent')
        }

        this.logger.log(`sent contact message ${ref} from user ${sender.account?.id ?? 'none'}`)
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

        const draft = await this.useDraft(input.draftId)

        if (!draft) {
            throw invalidDraft('Unknown, used or expired draft')
        }

        return draft.files
    }

    private useDraft(draftId: string): Promise<ContactDraftDoc | null> {
        const now = new Date()

        return this.drafts
            .findOneAndUpdate(
                { _id: draftId, usedAt: null, expiresAt: { $gt: now } },
                { $set: { usedAt: now } },
                { new: true },
            )
            .lean<ContactDraftDoc>()
    }

    private async readAttachments(files: ContactDraftFile[]): Promise<MailAttachment[]> {
        const objects = await this.readObjects(files)

        return files.map((file, index) => {
            const object = objects[index]

            if (!object || object.contentType !== file.contentType || object.content.length !== file.size) {
                throw invalidDraft('An image is missing or differs from the one declared')
            }

            return { filename: attachmentFilename(file.name, file.contentType), content: object.content }
        })
    }

    private async readObjects(files: ContactDraftFile[]): Promise<(ObjectContent | null)[]> {
        try {
            return await Promise.all(files.map((file) => this.storage.readObject(file.path)))
        } catch (err) {
            this.logger.error(`could not read a contact attachment: ${describeError(err)}`)
            throw unavailable('The message could not be sent')
        }
    }
}
