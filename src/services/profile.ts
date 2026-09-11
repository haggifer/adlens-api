import { FieldValue } from 'firebase-admin/firestore'

import { db } from '@/infra/firebase'
import { profileDoc } from '@/utils/paths'
import type { Profile } from 'adlens-shared'

interface ProfilePatch {
    displayName?: string
    photoURL?: string
}

export const updateProfile = async (uid: string, patch: ProfilePatch): Promise<Profile> => {
    const ref = db.doc(profileDoc(uid))
    const snap = await ref.get()
    const now = FieldValue.serverTimestamp()
    const created = snap.exists ? {} : { createdAt: now }

    await ref.set({ ...patch, ...created, updatedAt: now }, { merge: true })

    const updated = await ref.get()

    return updated.data() as Profile
}
