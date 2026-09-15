import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

export type QuotaDocument = HydratedDocument<Quota>

@Schema({ collection: 'quotas' })
export class Quota {
    @Prop({ type: String, required: true, unique: true, index: true })
    userId: string

    @Prop({ type: Number, required: true, default: 0 })
    used: number

    @Prop({ type: Number, required: true })
    limit: number

    @Prop({ type: Number, required: true })
    windowStart: number
}

export const QuotaSchema = SchemaFactory.createForClass(Quota)
