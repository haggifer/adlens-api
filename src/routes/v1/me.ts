import { updateProfileInputSchema } from 'adlens-types'
import { Router } from 'express'

import { uidOf } from '@/infra/auth'
import { updateProfile } from '@/services/profile'

export const meRouter = Router()

// PATCH /v1/me/profile — update allowlisted profile fields only.
meRouter.patch('/profile', async (req, res) => {
    const uid = uidOf(req)
    const patch = updateProfileInputSchema.parse(req.body)
    const profile = await updateProfile(uid, patch)
    res.json({ profile })
})
