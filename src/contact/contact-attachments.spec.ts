import { attachmentFilename, contactAttachmentPath } from './contact-attachments'

describe('Contact form attachments', () => {
    it('stores each image under its draft, by its position and type', () => {
        expect(contactAttachmentPath('d1', 0, 'image/png')).toBe('contact/d1/0.png')
        expect(contactAttachmentPath('d1', 1, 'image/jpeg')).toBe('contact/d1/1.jpg')
        expect(contactAttachmentPath('d1', 4, 'image/webp')).toBe('contact/d1/4.webp')
    })

    it("keeps the visitor's file name when it already ends in the image's extension", () => {
        expect(attachmentFilename('screenshot.PNG', 'image/png')).toBe('screenshot.PNG')
        expect(attachmentFilename('photo.jpeg', 'image/jpeg')).toBe('photo.jpeg')
    })

    it("adds the image's extension otherwise, so mail clients open it as an image", () => {
        expect(attachmentFilename('photo', 'image/jpeg')).toBe('photo.jpg')
        expect(attachmentFilename('shot.png', 'image/webp')).toBe('shot.png.webp')
    })

    it('replaces characters that are unsafe in a file name', () => {
        expect(attachmentFilename('my shot/../a"b.png', 'image/png')).toBe('my_shot_.._a_b.png')
    })
})
