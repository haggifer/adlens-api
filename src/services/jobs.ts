import { FieldValue } from 'firebase-admin/firestore'

import { db, storage } from '@/infra/firebase'
import { AppError } from '@/infra/errors'
import { jobsCollection, sanitizeFilename, uploadPath } from '@/utils/paths'
import type { CreateJobInput, Job } from 'adlens-shared'

const jobDoc = (uid: string, jobId: string) => db.doc(`${jobsCollection(uid)}/${jobId}`)

const toJob = (snap: FirebaseFirestore.DocumentSnapshot): Job => ({ id: snap.id, ...(snap.data() as Omit<Job, 'id'>) })

export const createJob = async (uid: string, input: CreateJobInput): Promise<Job> => {
    const ref = db.collection(jobsCollection(uid)).doc()
    const jobId = ref.id
    const name = sanitizeFilename(input.file.name)
    const bucket = storage.bucket().name
    const path = uploadPath(uid, Date.now(), name)
    const now = FieldValue.serverTimestamp()

    await ref.set({
        status: 'pending',
        settings: input.settings,
        file: { bucket, path, name, contentType: input.file.contentType, size: input.file.size },
        createdAt: now,
        updatedAt: now,
    })

    return getJob(uid, jobId)
}

export const getJob = async (uid: string, jobId: string): Promise<Job> => {
    const snap = await jobDoc(uid, jobId).get()

    if (!snap.exists) {
        throw new AppError(404, 'Job not found', 'not_found')
    }

    return toJob(snap)
}

export const updateJob = async (uid: string, jobId: string, patch: Partial<Omit<Job, 'id'>>): Promise<Job> => {
    await jobDoc(uid, jobId).update({ ...patch, updatedAt: FieldValue.serverTimestamp() })

    return getJob(uid, jobId)
}
