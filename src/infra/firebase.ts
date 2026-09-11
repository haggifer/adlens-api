import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { getFunctions } from 'firebase-admin/functions'
import { getStorage } from 'firebase-admin/storage'

// storageBucket is pinned from env so the server reads/writes the same bucket the client uploads to
// (the Admin SDK's default can otherwise resolve to the legacy <project>.appspot.com name).
const app = getApps().length ? getApps()[0] : initializeApp({ storageBucket: process.env.STORAGE_BUCKET })

export const db = getFirestore(app)
export const functions = getFunctions(app)
export const storage = getStorage(app)

const auth = getAuth(app)
export const verifyIdToken = auth.verifyIdToken.bind(auth)

// Firestore rejects `undefined` field values unless this is set.
db.settings({ ignoreUndefinedProperties: true })
