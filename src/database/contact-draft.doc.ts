import { contactAttachmentTypeSchema } from 'adlens-shared'
import { z } from 'zod'
import { zodToMongoose } from '../common/zod-to-mongoose'

export const CONTACT_DRAFT_MODEL = 'ContactDraft'

// The images a Contact form visitor declared before uploading them, under a random id that stands in for the
// Turnstile check once (usedAt). MongoDB deletes each draft when it expires; the objects stay until the bucket's
// lifecycle rule deletes them.
export const contactDraftDocSchema = z.object({
    _id: z.string(),
    files: z.array(
        z.object({
            path: z.string(),
            name: z.string(),
            contentType: contactAttachmentTypeSchema,
            size: z.number().int().positive(),
        }),
    ),
    expiresAt: z.date(),
    usedAt: z.date().nullable(),
})

export type ContactDraftDoc = z.infer<typeof contactDraftDocSchema>
export type ContactDraftFile = ContactDraftDoc['files'][number]

export const ContactDraftSchema = zodToMongoose(contactDraftDocSchema, { collection: 'contact_drafts' })
ContactDraftSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
