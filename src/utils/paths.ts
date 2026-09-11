export const jobsCollection = (uid: string) => `users/${uid}/jobs`

export const quotaDoc = (uid: string) => `users/${uid}/private/quota`

export const profileDoc = (uid: string) => `users/${uid}`

// Each upload gets its own timestamped folder holding the video and any derived files (e.g. result.json).
export const uploadFolder = (uid: string, timestamp: number) => `users/${uid}/${timestamp}`

export const uploadPath = (uid: string, timestamp: number, filename: string) =>
    `${uploadFolder(uid, timestamp)}/${filename}`

export const parentFolder = (path: string) => path.slice(0, path.lastIndexOf('/'))

export const resultPath = (folder: string) => `${folder}/result.json`

export const gcsUri = (bucket: string, path: string) => `gs://${bucket}/${path}`

export const sanitizeFilename = (name: string) => name.replace(/[^\w.-]+/g, '_').slice(0, 255) || 'upload'
