import { HttpStatus, Injectable } from '@nestjs/common'
import { InjectConnection } from '@nestjs/mongoose'
import {
    type AnalysisSettings,
    MAX_PRESETS,
    type Preset,
    RequestErrorCode,
    type SavePresetPayload,
} from 'adlens-shared'
import { type Connection, Types } from 'mongoose'
import { ApiException } from '../common/api-exception'
import { PRESET_COLLECTION, type PresetSetDoc, type StoredPreset } from './preset-set'

interface PresetChanges {
    name: string
    nameKey: string
    settings: AnalysisSettings
    updatedAt: Date
}

const presetLimitReached = () =>
    new ApiException(HttpStatus.CONFLICT, RequestErrorCode.PresetLimitReached, 'Preset limit reached')

const presetNameTaken = () =>
    new ApiException(HttpStatus.CONFLICT, RequestErrorCode.PresetNameTaken, 'Preset name taken')

const presetNotFound = () => new ApiException(HttpStatus.NOT_FOUND, RequestErrorCode.NotFound, 'Preset not found')

const toNameKey = (name: string) => name.toLowerCase()

const toChanges = (input: SavePresetPayload, now: Date): PresetChanges => {
    const name = input.name.trim()

    return { name, nameKey: toNameKey(name), settings: input.settings, updatedAt: now }
}

const createStoredPreset = (changes: PresetChanges): StoredPreset => ({
    id: new Types.ObjectId().toString(),
    ...changes,
    usageCount: 0,
    lastUsedAt: null,
    createdAt: changes.updatedAt,
})

const toPreset = (stored: StoredPreset, defaultPresetId: string | null): Preset => ({
    id: stored.id,
    name: stored.name,
    settings: stored.settings,
    isDefault: stored.id === defaultPresetId,
    usageCount: stored.usageCount,
    lastUsedAt: stored.lastUsedAt?.toISOString() ?? null,
    createdAt: stored.createdAt.toISOString(),
    updatedAt: stored.updatedAt.toISOString(),
})

const findPreset = (set: PresetSetDoc | null, presetId: string): Preset | null => {
    const stored = set?.presets.find((preset) => preset.id === presetId)

    return set && stored ? toPreset(stored, set.defaultPresetId) : null
}

// Without overwrite, an edit matches only while no other preset has the name.
const getUpdateFilter = (userId: string, presetId: string, nameKey: string, isOverwrite?: boolean) => {
    const filter = { _id: userId, 'presets.id': presetId }

    return isOverwrite ? filter : { ...filter, presets: { $not: { $elemMatch: { nameKey, id: { $ne: presetId } } } } }
}

// isDefault true makes the edited preset the default, and false clears the default when it is that preset. Otherwise
// the default stays, unless the edit drops it (an overwrite on rename): then it moves to the edited preset (spec D20).
const getDefaultAfterUpdate = (presetId: string, droppedIds: object, isDefault?: boolean) => {
    const id = { $literal: presetId }
    const kept = { $cond: [{ $in: ['$defaultPresetId', droppedIds] }, id, '$defaultPresetId'] }

    if (isDefault) {
        return id
    }

    return isDefault === false ? { $cond: [{ $eq: ['$defaultPresetId', id] }, null, kept] } : kept
}

// One update for an edit: it drops the other preset with the name (an overwrite on rename, spec D10; without overwrite
// the filter has ruled one out), updates this one and settles the default. User input goes in through $literal, so a
// name or id starting with $ is never read as a field path.
const getUpdatePipeline = (presetId: string, changes: PresetChanges, isDefault?: boolean) => {
    const isEdited = { $eq: ['$$this.id', { $literal: presetId }] }
    const isDropped = { $and: [{ $eq: ['$$this.nameKey', { $literal: changes.nameKey }] }, { $not: [isEdited] }] }
    const droppedIds = { $map: { input: { $filter: { input: '$presets', cond: isDropped } }, in: '$$this.id' } }
    const kept = { $filter: { input: '$presets', cond: { $not: [isDropped] } } }
    const edit = { $cond: [isEdited, { $mergeObjects: ['$$this', { $literal: changes }] }, '$$this'] }

    return [
        {
            $set: {
                defaultPresetId: getDefaultAfterUpdate(presetId, droppedIds, isDefault),
                presets: { $map: { input: kept, in: edit } },
                updatedAt: changes.updatedAt,
            },
        },
    ]
}

const getRemovePipeline = (presetId: string, now: Date) => {
    const id = { $literal: presetId }

    return [
        {
            $set: {
                presets: { $filter: { input: '$presets', cond: { $ne: ['$$this.id', id] } } },
                defaultPresetId: { $cond: [{ $eq: ['$defaultPresetId', id] }, null, '$defaultPresetId'] },
                updatedAt: now,
            },
        },
    ]
}

// A user's presets, in one document per user. Every write is a single conditional update on it, so concurrent
// requests can't pass the limit or give two presets one name.
@Injectable()
export class PresetsService {
    constructor(@InjectConnection() private readonly connection: Connection) {}

    private get sets() {
        return this.connection.collection<PresetSetDoc>(PRESET_COLLECTION)
    }

    async list(userId: string): Promise<Preset[]> {
        const set = await this.sets.findOne({ _id: userId })

        if (!set) {
            return []
        }

        return set.presets.map((preset) => toPreset(preset, set.defaultPresetId))
    }

    // A taken name is refused unless the save asks to overwrite that preset (spec D9).
    async create(userId: string, input: SavePresetPayload): Promise<{ preset: Preset; isCreated: boolean }> {
        const now = new Date()
        const changes = toChanges(input, now)

        await this.ensureSet(userId, now)

        if (input.overwrite) {
            const overwritten = await this.overwriteByName(userId, changes, input.isDefault)

            if (overwritten) {
                return { preset: overwritten, isCreated: false }
            }
        }

        const preset = await this.push(userId, createStoredPreset(changes), input.isDefault)

        return { preset, isCreated: true }
    }

    async update(userId: string, presetId: string, input: SavePresetPayload): Promise<Preset> {
        const changes = toChanges(input, new Date())
        const filter = getUpdateFilter(userId, presetId, changes.nameKey, input.overwrite)
        const pipeline = getUpdatePipeline(presetId, changes, input.isDefault)

        const set = await this.sets.findOneAndUpdate(filter, pipeline, { returnDocument: 'after' })
        const preset = findPreset(set, presetId)

        if (!preset) {
            const refusal = await this.getUpdateRefusal(userId, presetId)

            throw refusal
        }

        return preset
    }

    async remove(userId: string, presetId: string): Promise<void> {
        const removed = await this.sets.updateOne(
            { _id: userId, 'presets.id': presetId },
            getRemovePipeline(presetId, new Date()),
        )

        if (!removed.matchedCount) {
            throw presetNotFound()
        }
    }

    async setDefault(userId: string, presetId: string | null): Promise<void> {
        const now = new Date()

        if (presetId === null) {
            await this.sets.updateOne({ _id: userId }, { $set: { defaultPresetId: null, updatedAt: now } })

            return
        }

        const set = await this.sets.updateOne(
            { _id: userId, 'presets.id': presetId },
            { $set: { defaultPresetId: presetId, updatedAt: now } },
        )

        if (!set.matchedCount) {
            throw presetNotFound()
        }
    }

    // Every user's document exists before a conditional write, so a refused write is told apart from a missing
    // document. Concurrent upserts on _id don't collide: the server retries one that hits the duplicate key.
    private async ensureSet(userId: string, now: Date) {
        await this.sets.updateOne(
            { _id: userId },
            { $setOnInsert: { presets: [], defaultPresetId: null, createdAt: now, updatedAt: now } },
            { upsert: true },
        )
    }

    private async push(userId: string, stored: StoredPreset, isDefault?: boolean): Promise<Preset> {
        const pushed = await this.sets.updateOne(
            {
                _id: userId,
                'presets.nameKey': { $ne: stored.nameKey },
                $expr: { $lt: [{ $size: '$presets' }, MAX_PRESETS] },
            },
            {
                $push: { presets: stored },
                $set: { updatedAt: stored.createdAt, ...(isDefault ? { defaultPresetId: stored.id } : {}) },
            },
        )

        if (!pushed.matchedCount) {
            const refusal = await this.getCreateRefusal(userId, stored.nameKey)

            throw refusal
        }

        return toPreset(stored, isDefault ? stored.id : null)
    }

    // The preset of the name takes the new name casing and settings, and keeps its id and usage count. Null when no
    // preset has the name.
    private async overwriteByName(userId: string, changes: PresetChanges, isDefault?: boolean) {
        const set = await this.sets.findOneAndUpdate(
            { _id: userId, 'presets.nameKey': changes.nameKey },
            {
                $set: {
                    'presets.$.name': changes.name,
                    'presets.$.settings': changes.settings,
                    'presets.$.updatedAt': changes.updatedAt,
                    updatedAt: changes.updatedAt,
                },
            },
            { returnDocument: 'after' },
        )
        const stored = set?.presets.find((preset) => preset.nameKey === changes.nameKey)

        if (!stored) {
            return null
        }

        return this.applyDefault(userId, stored.id, isDefault)
    }

    private async applyDefault(userId: string, presetId: string, isDefault?: boolean): Promise<Preset> {
        if (isDefault) {
            await this.setDefault(userId, presetId)
        }

        if (isDefault === false) {
            await this.sets.updateOne(
                { _id: userId, defaultPresetId: presetId },
                { $set: { defaultPresetId: null, updatedAt: new Date() } },
            )
        }

        const set = await this.sets.findOne({ _id: userId })
        const preset = findPreset(set, presetId)

        if (!preset) {
            throw presetNotFound()
        }

        return preset
    }

    private async getCreateRefusal(userId: string, nameKey: string) {
        const set = await this.sets.findOne({ _id: userId }, { projection: { 'presets.nameKey': 1 } })
        const isNameTaken = set?.presets.some((preset) => preset.nameKey === nameKey)

        return isNameTaken ? presetNameTaken() : presetLimitReached()
    }

    private async getUpdateRefusal(userId: string, presetId: string) {
        const set = await this.sets.findOne({ _id: userId, 'presets.id': presetId }, { projection: { _id: 1 } })

        return set ? presetNameTaken() : presetNotFound()
    }
}
