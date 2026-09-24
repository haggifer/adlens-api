import { z } from 'zod'
import { zodToMongoose } from '../common/zod-to-mongoose'

export const CONTACT_MESSAGE_MODEL = 'ContactMessage'

const RETENTION_S = 24 * 60 * 60

// One record per Contact message sent, only for rate limiting: the sender and the time, never the message text.
// MongoDB deletes each record a day after it was written.
export const contactMessageDocSchema = z.object({
    email: z.string(),
})

export type ContactMessageDoc = z.infer<typeof contactMessageDocSchema>

export const ContactMessageSchema = zodToMongoose(contactMessageDocSchema, {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'contact_messages',
})
ContactMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_S })
ContactMessageSchema.index({ email: 1, createdAt: -1 })
