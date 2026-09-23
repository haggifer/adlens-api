// Every object a user owns lives under their prefix, so deleting an account is one prefix delete.
export const userPrefix = (userId: string) => `users/${userId}/`

export const jobVideoPath = (userId: string, jobId: string) => `${userPrefix(userId)}jobs/${jobId}/video`

export const gcsUri = (bucket: string, path: string) => `gs://${bucket}/${path}`

export const sanitizeFilename = (name: string) => name.replace(/[^\w.-]+/g, '_').slice(0, 255) || 'upload'
