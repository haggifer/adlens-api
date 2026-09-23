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

const zodDef = (schema: unknown): ZodDef => (schema as { _zod: { def: ZodDef } })._zod.def

const SCALAR_TYPES: Record<string, unknown> = {
    string: String,
    number: Number,
    boolean: Boolean,
    date: Date,
}

const buildField = (schema: unknown): unknown => {
    let node = schema
    let required = true
    let nullable = false
    let defaultValue: unknown

    for (;;) {
        const def = zodDef(node)

        if (def.type === 'optional') {
            required = false
            node = def.innerType
            continue
        }

        if (def.type === 'nullable') {
            required = false
            nullable = true
            node = def.innerType
            continue
        }

        if (def.type === 'default') {
            required = false
            defaultValue =
                typeof def.defaultValue === 'function' ? (def.defaultValue as () => unknown)() : def.defaultValue
            node = def.innerType
            continue
        }

        break
    }

    const def = zodDef(node)
    const field: Record<string, unknown> = {}

    if (def.type === 'object') {
        // Embedded objects are stored loosely (Mixed): the nested shape is typed in Zod and validated at
        // the API boundary, so leaving Mongoose unopinionated keeps evolving blobs migration-free.
        field.type = Object
    } else if (def.type === 'enum') {
        field.type = String
        field.enum = Object.values(def.entries ?? {})
    } else if (def.type === 'array') {
        field.type = [buildField(def.element)]
    } else if (SCALAR_TYPES[def.type]) {
        field.type = SCALAR_TYPES[def.type]
    } else {
        throw new Error(`zodToMongoose: unsupported Zod type "${def.type}"`)
    }

    if (required) {
        field.required = true
    }

    if (defaultValue === undefined && nullable) {
        defaultValue = null
    }

    if (defaultValue !== undefined) {
        field.default = defaultValue
    }

    return field
}

const buildDefinition = (shape: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, buildField(value)]))

// Builds a Mongoose schema from a Zod object schema. Field types, required-ness (from optional/nullable),
// defaults, and enums are derived; storage-only concerns (indexes, collection, hooks) are layered on by
// the caller.
export const zodToMongoose = (schema: z.ZodType, options?: SchemaOptions): Schema =>
    new Schema(buildDefinition(zodDef(schema).shape ?? {}) as SchemaDefinition, options)
