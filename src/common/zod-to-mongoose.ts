import { Schema, type SchemaDefinition, type SchemaOptions } from 'mongoose'
import type { z } from 'zod'

// Structural view of a Zod v4 schema's internal definition (schema._zod.def). Read structurally rather
// than via instanceof so it works even if the schema was built by a different copy of Zod.
interface ZodDef {
    type: string
    innerType?: unknown
    element?: unknown
    shape?: Record<string, unknown>
    entries?: Record<string, string>
    defaultValue?: unknown
}

interface UnwrappedField {
    node: unknown
    isRequired: boolean
    isNullable: boolean
    defaultValue: unknown
}

const SCALAR_TYPES: Record<string, unknown> = {
    string: String,
    number: Number,
    boolean: Boolean,
    date: Date,
}

// Which Zod schema built each Mongoose schema, so the database job derives every collection's validator from the same
// source as its model.
const ZOD_SCHEMAS = new WeakMap<Schema, z.ZodType>()

const zodDef = (schema: unknown): ZodDef => (schema as { _zod: { def: ZodDef } })._zod.def

const unwrap = (schema: unknown): UnwrappedField => {
    const field: UnwrappedField = { node: schema, isRequired: true, isNullable: false, defaultValue: undefined }

    for (;;) {
        const def = zodDef(field.node)

        switch (def.type) {
            case 'optional':
                field.isRequired = false
                break
            case 'nullable':
                field.isRequired = false
                field.isNullable = true
                break
            case 'default':
                field.isRequired = false
                field.defaultValue =
                    typeof def.defaultValue === 'function' ? (def.defaultValue as () => unknown)() : def.defaultValue
                break
            default:
                return field
        }

        field.node = def.innerType
    }
}

const getTypeOptions = (def: ZodDef): Record<string, unknown> => {
    switch (def.type) {
        // Embedded objects are stored loosely (Mixed): the nested shape is typed in Zod and validated at
        // the API boundary, so leaving Mongoose unopinionated keeps evolving blobs migration-free.
        case 'object':
            return { type: Object }
        case 'enum':
            return { type: String, enum: Object.values(def.entries ?? {}) }
        case 'array':
            return { type: [buildField(def.element)] }
        default:
            if (SCALAR_TYPES[def.type]) {
                return { type: SCALAR_TYPES[def.type] }
            }

            throw new Error(`zodToMongoose: unsupported Zod type "${def.type}"`)
    }
}

const buildField = (schema: unknown): unknown => {
    const { node, isRequired, isNullable, defaultValue } = unwrap(schema)
    const storedDefault = defaultValue === undefined && isNullable ? null : defaultValue

    return {
        ...getTypeOptions(zodDef(node)),
        ...(isRequired && { required: true }),
        ...(storedDefault !== undefined && { default: storedDefault }),
    }
}

const buildDefinition = (shape: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, buildField(value)]))

// Field types, required-ness (from optional/nullable), defaults, and enums are derived; storage-only concerns (indexes,
// collection, hooks) are layered on by the caller.
export const zodToMongoose = (schema: z.ZodType, options?: SchemaOptions): Schema => {
    const mongooseSchema = new Schema(buildDefinition(zodDef(schema).shape ?? {}) as SchemaDefinition, options)

    ZOD_SCHEMAS.set(mongooseSchema, schema)

    return mongooseSchema
}

export const getZodSchema = (schema: Schema): z.ZodType | undefined => ZOD_SCHEMAS.get(schema)
