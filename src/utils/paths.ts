export const jobsCollection = (uid: string) => `users/${uid}/jobs`

export const gcsUri = (bucket: string, path: string) => `gs://${bucket}/${path}`
