import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import type { Profile as ProfileEntity, UpdateProfileInput } from 'adlens-shared'
import { Model } from 'mongoose'

import { Profile, ProfileDocument } from '../schemas/profile.schema'

const toEntity = (doc: ProfileDocument): ProfileEntity => ({
    displayName: doc.displayName,
    photoURL: doc.photoURL,
    createdAt: doc.get('createdAt'),
    updatedAt: doc.get('updatedAt'),
})

@Injectable()
export class ProfileService {
    constructor(@InjectModel(Profile.name) private readonly model: Model<ProfileDocument>) {}

    async get(userId: string): Promise<ProfileEntity | null> {
        const doc = await this.model.findOne({ userId })

        return doc ? toEntity(doc) : null
    }

    async update(userId: string, patch: UpdateProfileInput): Promise<ProfileEntity> {
        const doc = await this.model.findOneAndUpdate({ userId }, { $set: patch }, { new: true, upsert: true })

        return toEntity(doc)
    }
}
