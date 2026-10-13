import { HttpStatus, Injectable } from '@nestjs/common'
import { InjectConnection } from '@nestjs/mongoose'
import {
    type AnalysisSettings,
    MAX_PRESETS,
    PRESET_NAME_MAX_LENGTH,
    type Preset,
    RequestErrorCode,
    type SavePresetPayload,
} from 'adlens-shared'
import { type Connection, Types } from 'mongoose'
import { ApiException } from '../common/api-exception'
import { PRESET_COLLECTION, type PresetSetDoc, type StoredPreset } from './preset-set'
import { isSameSettings } from './same-settings'

interface PresetChanges {
    name: string
    nameKey: string
    settings: AnalysisSettings
    updatedAt: Date
}

const TRANSFER_ATTEMPTS = 3

const presetLimitReached = () =>
    new ApiException(HttpStatus.CONFLICT, RequestErrorCode.PresetLimitReached, 'Preset limit reached')

const presetNameTaken = () =>
    new ApiException(HttpStatus.CONFLICT, RequestErrorCode.PresetNameTaken, 'Preset name taken')

const presetNotFound = () => new ApiException(HttpStatus.NOT_FOUND, RequestErrorCode.NotFound, 'Preset not found')

const toNameKey = (name: string) => name.toLowerCase()

// The base is cut short when the number would take the name past the limit, so a renamed preset can be edited later.
const toFreeName = (name: string, takenKeys: Set<string>): string => {
    if (!takenKeys.has(toNameKey(name))) {
        return name
    }

    for (let n = 2; ; n++) {
        const suffix = ` (${n})`
        const candidate = `${name.slice(0, PRESET_NAME_MAX_LENGTH - suffix.length).trimEnd()}${suffix}`

        if (!takenKeys.has(toNameKey(candidate))) {
            return candidate
        }
    }
}

// The presets an account still lacks. A name that doesn't clash with the account keeps its own name, reserved before any
// clashing one is numbered, so a number never lands on a name the anonymous user already had.
const planMoves = (incoming: StoredPreset[], account: PresetSetDoc | null): StoredPreset[] => {
    const ownIds = new Set(account?.presets.map((preset) => preset.id))
    const takenKeys = new Set(account?.presets.map((preset) => preset.nameKey))
    const missing = incoming.filter((preset) => !ownIds.has(preset.id))
    const keptIds = new Set(missing.filter((preset) => !takenKeys.has(preset.nameKey)).map((preset) => preset.id))

    missing.filter((preset) => keptIds.has(preset.id)).forEach((preset) => takenKeys.add(preset.nameKey))

    return missing.map((preset) => {
        if (keptIds.has(preset.id)) {
            return preset
        }

        const name = toFreeName(preset.name, takenKeys)

        takenKeys.add(toNameKey(name))

        return { ...preset, name, nameKey: toNameKey(name) }
    })
}

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
// the default stays, unless the edit drops it (an overwrite on rename): then it moves to the edited preset.
const getDefaultAfterUpdate = (presetId: string, droppedIds: object, isDefault?: boolean) => {
    const id = { $literal: presetId }
    const kept = { $cond: [{ $in: ['$defaultPresetId', droppedIds] }, id, '$defaultPresetId'] }

    if (isDefault) {
        return id
    }

    return isDefault === false ? { $cond: [{ $eq: ['$defaultPresetId', id] }, null, kept] } : kept
}

// One update for an edit: it drops the other preset with the name (an overwrite on rename; without overwrite the
// filter has ruled one out), updates this one and settles the default. User input goes in through $literal, so a
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

    // A taken name is refused unless the save asks to overwrite that preset.
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

    // Counts a started run for the preset and answers its name; null when the preset is gone or its settings differ
    // from the run's. The update matches the preset as it was read, so an edit in between counts nothing.
    async recordUse(
        userId: string,
        presetId: string,
        settings: AnalysisSettings,
        now = new Date(),
    ): Promise<string | null> {
        const set = await this.sets.findOne({ _id: userId })
        const stored = set?.presets.find((preset) => preset.id === presetId)

        if (!stored || !isSameSettings(stored.settings, settings)) {
            return null
        }

        const counted = await this.sets.updateOne(
            { _id: userId },
            { $inc: { 'presets.$[p].usageCount': 1 }, $set: { 'presets.$[p].lastUsedAt': now } },
            { arrayFilters: [{ 'p.id': presetId, 'p.updatedAt': stored.updatedAt }] },
        )

        return counted.modifiedCount === 1 ? stored.name : null
    }

    // Sign-in or sign-up moves an anonymous user's presets to the account: a clashing name gets a number, the limit
    // isn't applied, and a preset an earlier, interrupted attempt already moved is skipped, so a retry is safe. The push
    // matches only while the account still has none of the ids and names it adds: when a concurrent link or save got
    // there first, the plan is made again from the account as it is now.
    async transfer(fromUserId: string, toUserId: string, now = new Date()): Promise<void> {
        for (let attempt = 0; attempt < TRANSFER_ATTEMPTS; attempt++) {
            const from = await this.sets.findOne({ _id: fromUserId })

            if (!from) {
                return
            }

            await this.ensureSet(toUserId, now)

            const to = await this.sets.findOne({ _id: toUserId })
            const moved = planMoves(from.presets, to)
            const isPushed = await this.pushMoved(toUserId, moved, now)

            if (isPushed) {
                await this.sets.updateOne(
                    { _id: toUserId, defaultPresetId: null },
                    { $set: { defaultPresetId: from.defaultPresetId } },
                )
                await this.sets.deleteOne({ _id: fromUserId })

                return
            }
        }

        throw new Error(`could not move the presets of user ${fromUserId} to user ${toUserId}`)
    }

    async purge(userId: string): Promise<void> {
        await this.sets.deleteOne({ _id: userId })
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

    private async pushMoved(userId: string, moved: StoredPreset[], now: Date): Promise<boolean> {
        if (!moved.length) {
            return true
        }

        const pushed = await this.sets.updateOne(
            {
                _id: userId,
                'presets.id': { $nin: moved.map((preset) => preset.id) },
                'presets.nameKey': { $nin: moved.map((preset) => preset.nameKey) },
            },
            { $push: { presets: { $each: moved } }, $set: { updatedAt: now } },
        )

        return pushed.matchedCount === 1
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
