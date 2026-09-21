import { profileDocSchema, type ProfileDoc } from 'adlens-shared'
import { HydratedDocument } from 'mongoose'
import { zodToMongoose } from '../common/zod-to-mongoose'

export const PROFILE_MODEL = 'Profile'

export type ProfileDocument = HydratedDocument<ProfileDoc>

export const ProfileSchema = zodToMongoose(profileDocSchema, { timestamps: true, collection: 'profiles' })
ProfileSchema.index({ userId: 1 }, { unique: true })
