import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { getFunctions } from 'firebase-admin/functions'

const app = getApps().length ? getApps()[0] : initializeApp()

export const db = getFirestore(app)
export const functions = getFunctions(app)

const auth = getAuth(app)
export const verifyIdToken = auth.verifyIdToken.bind(auth)

// Firestore rejects `undefined` field values unless this is set.
db.settings({ ignoreUndefinedProperties: true })
