import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

export type ProfileDocument = HydratedDocument<Profile>

@Schema({ timestamps: true, collection: 'profiles' })
export class Profile {
    @Prop({ type: String, required: true, unique: true, index: true })
    userId: string

    @Prop({ type: String })
    displayName?: string

    @Prop({ type: String })
    photoURL?: string
}

export const ProfileSchema = SchemaFactory.createForClass(Profile)
