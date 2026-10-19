import { isDeepStrictEqual } from 'node:util'
import type { Connection, Model, mongo } from 'mongoose'
import { z } from 'zod'
import { getZodSchema } from '../common/zod-to-mongoose'

type JsonSchema = Record<string, unknown>

export interface ValidatorResult {
    collection: string
    // The stored validator isn't the declared one: replaced when applied.
    isOutdated: boolean
    // Documents the declared validator refuses: a migration must fix them before the collection's action becomes
    // `error`.
    invalidCount: number
}

type ValidationSettings = Pick<mongo.CreateCollectionOptions, 'validator' | 'validationLevel' | 'validationAction'>

// The $jsonSchema keywords copied as they are (MongoDB's list, minus the ones converted below).
const COPIED_KEYWORDS = new Set([
    'bsonType',
    'enum',
    'required',
    'title',
    'description',
    'minProperties',
    'maxProperties',
    'maxItems',
    'minItems',
    'uniqueItems',
    'maxLength',
    'minLength',
    'pattern',
    'maximum',
    'exclusiveMaximum',
    'minimum',
    'exclusiveMinimum',
    'multipleOf',
])
// Keywords that only annotate or that MongoDB can't apply (a record's key pattern): left out, losing no stored-shape rule
// the database could check.
const DROPPED_KEYWORDS = new Set(['$schema', 'default', 'format', 'propertyNames'])
const SUBSCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'allOf'])
// The BSON types the driver stores a JS integer as.
const INTEGER_TYPES = ['int', 'long']
const BSON_TYPES: Record<string, string[]> = {
    integer: INTEGER_TYPES,
    number: ['number'],
    string: ['string'],
    boolean: ['bool'],
    object: ['object'],
    array: ['array'],
    null: ['null'],
}
// Warn until each collection's documents all pass: a refused write is only logged, and `moderate` leaves documents
// that were already invalid alone on update.
const VALIDATION_OPTIONS: Omit<ValidationSettings, 'validator'> = {
    validationLevel: 'moderate',
    validationAction: 'warn',
}

const toBsonTypes = (type: unknown): string[] => [type].flat().flatMap((name) => BSON_TYPES[name as string] ?? [])

const toBsonProperties = (properties: Record<string, JsonSchema>): JsonSchema =>
    Object.fromEntries(Object.entries(properties).map(([name, property]) => [name, toBsonSchema(property)]))

// One keyword of Zod's draft-4 output in MongoDB's dialect; a keyword MongoDB has no equivalent for throws, so a
// schema change that needs one fails in the tests, not in the deploy.
const convertKeyword = (key: string, value: unknown): JsonSchema => {
    switch (key) {
        case 'properties':
            return { properties: toBsonProperties(value as Record<string, JsonSchema>) }
        case 'items':
            return { items: Array.isArray(value) ? value.map(toBsonSchema) : toBsonSchema(value as JsonSchema) }
        case 'not':
            return { not: toBsonSchema(value as JsonSchema) }
        // Objects stay open: stored documents carry `_id`, timestamps and `__v`, which the Zod shapes leave out. A
        // record's value schema is kept.
        case 'additionalProperties':
            return typeof value === 'object' ? { additionalProperties: toBsonSchema(value as JsonSchema) } : {}
        case 'type':
            return { bsonType: toBsonTypes(value) }
        case 'const':
            return { enum: [value] }
        default:
            if (SUBSCHEMA_LISTS.has(key)) {
                return { [key]: (value as JsonSchema[]).map(toBsonSchema) }
            }

            if (COPIED_KEYWORDS.has(key)) {
                return { [key]: value }
            }

            if (DROPPED_KEYWORDS.has(key)) {
                return {}
            }

            throw new Error(`toValidator: no MongoDB $jsonSchema equivalent for the keyword "${key}"`)
    }
}

const toBsonSchema = (schema: JsonSchema): JsonSchema =>
    Object.assign({}, ...Object.entries(schema).map(([key, value]) => convertKeyword(key, value))) as JsonSchema

// The validator a collection's documents must pass, from the Zod schema its model was built from: dates as BSON
// dates, and what a document may hold before its defaults apply (the input side).
export const toValidator = (schema: z.ZodType): mongo.Document => {
    const jsonSchema = z.toJSONSchema(schema, {
        target: 'draft-4',
        io: 'input',
        unrepresentable: 'any',
        override: ({ zodSchema, jsonSchema: node }) => {
            if (zodSchema._zod.def.type === 'date') {
                node.bsonType = 'date'
            }
        },
    })

    return { $jsonSchema: toBsonSchema(jsonSchema as JsonSchema) }
}

// The collection's validation settings, or undefined when the collection doesn't exist yet.
const readValidation = async (connection: Connection, collection: string): Promise<ValidationSettings | undefined> => {
    const [info] = await connection.db!.listCollections({ name: collection }).toArray()

    if (!info) {
        return undefined
    }

    const { validator, validationLevel, validationAction } = ((info as mongo.CollectionInfo).options ??
        {}) as ValidationSettings

    return { validator, validationLevel, validationAction }
}

const applyValidation = async (connection: Connection, collection: string, settings: ValidationSettings) => {
    const db = connection.db!
    const exists = (await readValidation(connection, collection)) !== undefined

    if (exists) {
        await db.command({ collMod: collection, ...settings })
    } else {
        await db.createCollection(collection, settings)
    }
}

const syncValidator = async (
    connection: Connection,
    model: Model<unknown>,
    isApplied: boolean,
): Promise<ValidatorResult> => {
    const collection = model.collection.collectionName
    const validator = toValidator(getZodSchema(model.schema)!)
    const settings = { validator, ...VALIDATION_OPTIONS }
    const stored = await readValidation(connection, collection)

    const isOutdated = !isDeepStrictEqual(stored, settings)
    const invalidCount = await connection.collection(collection).countDocuments({ $nor: [validator] })

    if (isApplied && isOutdated) {
        await applyValidation(connection, collection, settings)
    }

    return { collection, isOutdated, invalidCount }
}

// Every model built from a Zod schema gets that schema as its collection's validator, and the documents it refuses are
// counted, whether or not it is applied.
export const syncValidators = async (connection: Connection, isApplied: boolean): Promise<ValidatorResult[]> => {
    const models = (Object.values(connection.models) as Model<unknown>[]).filter((model) => getZodSchema(model.schema))

    return Promise.all(models.map((model) => syncValidator(connection, model, isApplied)))
}
