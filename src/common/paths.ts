// Each upload gets its own timestamped folder holding the video and any derived files (result.json).
export const uploadFolder = (userId: string, timestamp: number) => `users/${userId}/${timestamp}`

export const uploadPath = (userId: string, timestamp: number, filename: string) =>
    `${uploadFolder(userId, timestamp)}/${filename}`

export const parentFolder = (path: string) => path.slice(0, path.lastIndexOf('/'))

export const resultPath = (folder: string) => `${folder}/result.json`

export const gcsUri = (bucket: string, path: string) => `gs://${bucket}/${path}`

export const sanitizeFilename = (name: string) => name.replace(/[^\w.-]+/g, '_').slice(0, 255) || 'upload'
