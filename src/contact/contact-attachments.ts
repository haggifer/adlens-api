import type { ContactAttachmentType } from 'adlens-shared'
import { sanitizeFilename } from '../common/paths'

const EXTENSIONS: Record<ContactAttachmentType, string[]> = {
    'image/png': ['.png'],
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/webp': ['.webp'],
}

// Outside every user's prefix: a lifecycle rule deletes everything under contact/ 30 days after upload.
export const contactAttachmentPath = (draftId: string, index: number, contentType: ContactAttachmentType) =>
    `contact/${draftId}/${index}${EXTENSIONS[contentType][0]}`

// Mail clients pick how to open an attachment by its extension, so it always matches the verified type.
export const attachmentFilename = (name: string, contentType: ContactAttachmentType) => {
    const filename = sanitizeFilename(name)
    const extensions = EXTENSIONS[contentType]
    const hasExtension = extensions.some((extension) => filename.toLowerCase().endsWith(extension))

    return hasExtension ? filename : `${filename}${extensions[0]}`
}
