import { FieldValue } from 'firebase-admin/firestore'

import { db } from '@/lib/firebase'
import { AppError } from '@/lib/errors'
import { jobsCollection } from '@/utils/paths'
import type { CreateJobInput, Job, JobStatus } from 'adlens-types'

const jobDoc = (uid: string, jobId: string) => db.doc(`${jobsCollection(uid)}/${jobId}`)

const toJob = (snap: FirebaseFirestore.DocumentSnapshot): Job => ({ id: snap.id, ...(snap.data() as Omit<Job, 'id'>) })

export const createJob = async (uid: string, input: CreateJobInput): Promise<Job> => {
    const ref = db.collection(jobsCollection(uid)).doc()
    const now = FieldValue.serverTimestamp()

    await ref.set({
        status: 'pending' satisfies JobStatus,
        file: input.file ?? null,
        createdAt: now,
        updatedAt: now,
    })

    return getJob(uid, ref.id)
}

export const getJob = async (uid: string, jobId: string): Promise<Job> => {
    const snap = await jobDoc(uid, jobId).get()

    if (!snap.exists) {
        throw new AppError(404, 'Job not found', 'not_found')
    }

    return toJob(snap)
}

export const listJobs = async (uid: string): Promise<Job[]> => {
    const snap = await db.collection(jobsCollection(uid)).orderBy('createdAt', 'desc').get()

    return snap.docs.map(toJob)
}

export const updateJob = async (uid: string, jobId: string, patch: Partial<Omit<Job, 'id'>>): Promise<Job> => {
    await jobDoc(uid, jobId).update({ ...patch, updatedAt: FieldValue.serverTimestamp() })

    return getJob(uid, jobId)
}

export const deleteJob = async (uid: string, jobId: string): Promise<void> => {
    await jobDoc(uid, jobId).delete()
}
