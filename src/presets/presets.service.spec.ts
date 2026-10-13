import { HttpStatus } from '@nestjs/common'
import {
    type AnalysisSettings,
    Market,
    MAX_PRESETS,
    Placement,
    Platform,
    RequestErrorCode,
    type SavePresetPayload,
} from 'adlens-shared'
import { Types } from 'mongoose'
import { ApiException } from '../common/api-exception'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { PRESET_COLLECTION, type PresetSetDoc } from './preset-set'
import { PresetsService } from './presets.service'

const META_US: AnalysisSettings = { platforms: [Platform.Meta], placements: [Placement.MetaFeed], markets: [Market.US] }

const TIKTOK_EU: AnalysisSettings = {
    platforms: [Platform.TikTok],
    placements: [Placement.TikTokInFeed],
    markets: [Market.EU, Market.UK],
}

const refusal = (status: HttpStatus, errorCode: RequestErrorCode) => ({ status, response: { errorCode } })

const NAME_TAKEN = refusal(HttpStatus.CONFLICT, RequestErrorCode.PresetNameTaken)
const LIMIT_REACHED = refusal(HttpStatus.CONFLICT, RequestErrorCode.PresetLimitReached)
const NOT_FOUND = refusal(HttpStatus.NOT_FOUND, RequestErrorCode.NotFound)

describe('PresetsService', () => {
    let mongo: MemoryMongo
    let presets: PresetsService
    let userId: string

    const sets = () => mongo.connection.collection<PresetSetDoc>(PRESET_COLLECTION)

    const input = (name: string, fields: Partial<SavePresetPayload> = {}): SavePresetPayload => ({
        name,
        settings: META_US,
        ...fields,
    })

    const create = async (name: string, fields: Partial<SavePresetPayload> = {}) => {
        const { preset } = await presets.create(userId, input(name, fields))

        return preset
    }

    const fill = async (count: number) => {
        for (let i = 0; i < count; i++) {
            await create(`Preset ${i}`)
        }
    }

    const getDefaultId = async () => (await presets.list(userId)).find((preset) => preset.isDefault)?.id ?? null

    const getNames = async () => (await presets.list(userId)).map((preset) => preset.name)

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        presets = new PresetsService(mongo.connection)
    })

    beforeEach(() => {
        userId = new Types.ObjectId().toString()
    })

    afterEach(async () => {
        await sets().deleteMany({})
    })

    afterAll(async () => {
        await mongo.stop()
    })

    it('lists nothing for a user who has no presets', async () => {
        expect(await presets.list(userId)).toEqual([])
    })

    it('creates a preset with a trimmed name, unused and not the default', async () => {
        const result = await presets.create(userId, input('  Meta US  '))

        expect(result.isCreated).toBe(true)
        expect(await presets.list(userId)).toEqual([
            {
                id: result.preset.id,
                name: 'Meta US',
                settings: META_US,
                isDefault: false,
                usageCount: 0,
                lastUsedAt: null,
                createdAt: expect.any(String),
                updatedAt: expect.any(String),
            },
        ])
        expect(result.preset).toEqual((await presets.list(userId))[0])
    })

    it('refuses a name another preset has, ignoring case', async () => {
        await create('Meta US')

        const attempt = presets.create(userId, input('meta us', { settings: TIKTOK_EU }))

        await expect(attempt).rejects.toBeInstanceOf(ApiException)
        await expect(attempt).rejects.toMatchObject(NAME_TAKEN)
        expect(await getNames()).toEqual(['Meta US'])
    })

    it('refuses a preset past the limit, but still overwrites one by name at the limit', async () => {
        await fill(MAX_PRESETS)

        await expect(presets.create(userId, input('One more'))).rejects.toMatchObject(LIMIT_REACHED)

        const result = await presets.create(userId, input('PRESET 3', { settings: TIKTOK_EU, overwrite: true }))

        expect(result).toMatchObject({ isCreated: false, preset: { name: 'PRESET 3', settings: TIKTOK_EU } })
        expect(await presets.list(userId)).toHaveLength(MAX_PRESETS)
    })

    it('lets only one of two concurrent creates with one name through', async () => {
        const results = await Promise.allSettled([create('Meta US'), create('META US')])

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: NAME_TAKEN })
        expect(await presets.list(userId)).toHaveLength(1)
    })

    it('lets only one of two concurrent creates past the limit', async () => {
        await fill(MAX_PRESETS - 1)

        const results = await Promise.allSettled([create('First'), create('Second')])

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: LIMIT_REACHED })
        expect(await presets.list(userId)).toHaveLength(MAX_PRESETS)
    })

    it('overwrites a preset by name on create, keeping its id and usage count', async () => {
        const original = await create('Meta US')

        await sets().updateOne({ _id: userId }, { $set: { 'presets.0.usageCount': 3 } })

        const result = await presets.create(userId, input('META us', { settings: TIKTOK_EU, overwrite: true }))

        expect(result).toEqual({
            isCreated: false,
            preset: expect.objectContaining({ id: original.id, name: 'META us', settings: TIKTOK_EU, usageCount: 3 }),
        })
        expect(await presets.list(userId)).toEqual([result.preset])
    })

    it('creates a preset with overwrite when no preset has the name', async () => {
        const result = await presets.create(userId, input('Meta US', { overwrite: true }))

        expect(result).toMatchObject({ isCreated: true, preset: { name: 'Meta US' } })
    })

    it('keeps a name that starts with $ as text', async () => {
        const preset = await create('$presets')

        await presets.update(userId, preset.id, input('$name', { settings: TIKTOK_EU, overwrite: true }))

        expect(await getNames()).toEqual(['$name'])
    })

    it('renames a preset and changes its settings', async () => {
        const preset = await create('Meta US')

        const updated = await presets.update(userId, preset.id, input('TikTok EU', { settings: TIKTOK_EU }))

        expect(updated).toMatchObject({ id: preset.id, name: 'TikTok EU', settings: TIKTOK_EU, usageCount: 0 })
        expect(await presets.list(userId)).toEqual([updated])
    })

    it('lets a preset change the casing of its own name', async () => {
        const preset = await create('Meta US')

        await presets.update(userId, preset.id, input('META US'))

        expect(await getNames()).toEqual(['META US'])
    })

    it('refuses to update an unknown preset', async () => {
        await create('Meta US')

        await expect(presets.update(userId, 'unknown', input('Other'))).rejects.toMatchObject(NOT_FOUND)
        await expect(presets.update(userId, 'unknown', input('Other', { overwrite: true }))).rejects.toMatchObject(
            NOT_FOUND,
        )
        await expect(presets.update(new Types.ObjectId().toString(), 'unknown', input('Other'))).rejects.toMatchObject(
            NOT_FOUND,
        )
    })

    it('refuses to rename a preset to the name of another one', async () => {
        await create('Meta US')
        const other = await create('TikTok EU', { settings: TIKTOK_EU })

        await expect(presets.update(userId, other.id, input('meta us'))).rejects.toMatchObject(NAME_TAKEN)
        expect(await getNames()).toEqual(['Meta US', 'TikTok EU'])
    })

    it('removes the other preset of the name on a rename with overwrite, keeping its own usage count', async () => {
        await create('Meta US')
        const renamed = await create('TikTok EU', { settings: TIKTOK_EU })

        await sets().updateOne({ _id: userId }, { $set: { 'presets.0.usageCount': 5, 'presets.1.usageCount': 2 } })

        const updated = await presets.update(userId, renamed.id, input('meta us', { overwrite: true }))

        expect(updated).toMatchObject({ id: renamed.id, name: 'meta us', settings: META_US, usageCount: 2 })
        expect(await presets.list(userId)).toEqual([updated])
    })

    it('makes the renamed preset the default when the one it overwrites was the default', async () => {
        await create('Meta US', { isDefault: true })
        const renamed = await create('TikTok EU', { settings: TIKTOK_EU })

        const updated = await presets.update(userId, renamed.id, input('Meta US', { overwrite: true }))

        expect(updated.isDefault).toBe(true)
        expect(await getDefaultId()).toBe(renamed.id)
    })

    // Unchecking "Select as default" clears the default only when it is this preset (spec D22); the overwritten
    // preset's default still moves to it (D20).
    it('moves the overwritten default to the renamed preset even when the save leaves it unchecked', async () => {
        await create('Meta US', { isDefault: true })
        const renamed = await create('TikTok EU', { settings: TIKTOK_EU })

        await presets.update(userId, renamed.id, input('Meta US', { overwrite: true, isDefault: false }))

        expect(await getDefaultId()).toBe(renamed.id)
    })

    it('sets the default from isDefault on create and update, keeping one default', async () => {
        const first = await create('Meta US', { isDefault: true })
        const second = await create('TikTok EU', { settings: TIKTOK_EU, isDefault: true })

        expect(second.isDefault).toBe(true)
        expect(await getDefaultId()).toBe(second.id)

        const updated = await presets.update(userId, first.id, input('Meta US', { isDefault: true }))

        expect(updated.isDefault).toBe(true)
        expect((await presets.list(userId)).filter((preset) => preset.isDefault)).toEqual([updated])
    })

    it('makes a preset overwritten on create the default when asked', async () => {
        const preset = await create('Meta US')

        const result = await presets.create(userId, input('Meta US', { overwrite: true, isDefault: true }))

        expect(result.preset.isDefault).toBe(true)
        expect(await getDefaultId()).toBe(preset.id)
    })

    it('clears the default only when isDefault is false on the default, and leaves it when omitted', async () => {
        const preset = await create('Meta US', { isDefault: true })
        const other = await create('TikTok EU', { settings: TIKTOK_EU })

        await presets.update(userId, other.id, input('TikTok EU', { isDefault: false }))
        expect(await getDefaultId()).toBe(preset.id)

        await presets.update(userId, preset.id, input('Meta US', { settings: TIKTOK_EU }))
        expect(await getDefaultId()).toBe(preset.id)

        const updated = await presets.update(userId, preset.id, input('Meta US', { isDefault: false }))

        expect(updated.isDefault).toBe(false)
        expect(await getDefaultId()).toBeNull()
    })

    it('sets and clears the default directly', async () => {
        const preset = await create('Meta US')

        await presets.setDefault(userId, preset.id)
        expect(await getDefaultId()).toBe(preset.id)

        await presets.setDefault(userId, null)
        expect(await getDefaultId()).toBeNull()
    })

    it('refuses to make an unknown preset the default', async () => {
        await create('Meta US')

        await expect(presets.setDefault(userId, 'unknown')).rejects.toMatchObject(NOT_FOUND)
        await expect(presets.setDefault(new Types.ObjectId().toString(), 'unknown')).rejects.toMatchObject(NOT_FOUND)
    })

    it('removes a preset', async () => {
        const removed = await create('Meta US')

        await create('TikTok EU', { settings: TIKTOK_EU })
        await presets.remove(userId, removed.id)

        expect(await getNames()).toEqual(['TikTok EU'])
    })

    it('clears the default when the default is removed, and keeps it when another preset is', async () => {
        const preset = await create('Meta US', { isDefault: true })
        const other = await create('TikTok EU', { settings: TIKTOK_EU })

        await presets.remove(userId, other.id)
        expect(await getDefaultId()).toBe(preset.id)

        await presets.remove(userId, preset.id)
        expect((await sets().findOne({ _id: userId }))?.defaultPresetId).toBeNull()
    })

    it('refuses to remove an unknown preset', async () => {
        await create('Meta US')

        await expect(presets.remove(userId, 'unknown')).rejects.toMatchObject(NOT_FOUND)
        await expect(presets.remove(new Types.ObjectId().toString(), 'unknown')).rejects.toMatchObject(NOT_FOUND)
    })

    it('counts a use when the settings equal the preset, in any order', async () => {
        const preset = await create('TikTok EU', { settings: TIKTOK_EU })
        const other = await create('Meta US')
        const now = new Date('2026-10-13T12:00:00Z')
        const reordered = { ...TIKTOK_EU, markets: [Market.UK, Market.EU] }

        expect(await presets.recordUse(userId, preset.id, reordered, now)).toBe('TikTok EU')

        const [counted, untouched] = await presets.list(userId)

        expect(counted).toMatchObject({ id: preset.id, usageCount: 1, lastUsedAt: now.toISOString() })
        expect(untouched).toMatchObject({ id: other.id, usageCount: 0, lastUsedAt: null })
    })

    it('counts nothing when the settings differ from the preset', async () => {
        const preset = await create('TikTok EU', { settings: TIKTOK_EU })
        const before = await presets.list(userId)

        expect(await presets.recordUse(userId, preset.id, { ...TIKTOK_EU, markets: [Market.EU] })).toBeNull()
        expect(await presets.list(userId)).toEqual(before)
    })

    it('counts nothing for a deleted or unknown preset', async () => {
        const preset = await create('Meta US')

        await presets.remove(userId, preset.id)

        expect(await presets.recordUse(userId, preset.id, META_US)).toBeNull()
        expect(await presets.recordUse(userId, 'unknown', META_US)).toBeNull()
        expect(await presets.recordUse(new Types.ObjectId().toString(), 'unknown', META_US)).toBeNull()
    })

    it("counts nothing for another user's preset", async () => {
        const preset = await create('Meta US')

        expect(await presets.recordUse(new Types.ObjectId().toString(), preset.id, META_US)).toBeNull()
        expect((await presets.list(userId))[0]).toMatchObject({ usageCount: 0, lastUsedAt: null })
    })

    it("never touches another user's presets", async () => {
        const preset = await create('Meta US')
        const otherUserId = new Types.ObjectId().toString()

        await expect(presets.update(otherUserId, preset.id, input('Other'))).rejects.toMatchObject(NOT_FOUND)
        await expect(presets.remove(otherUserId, preset.id)).rejects.toMatchObject(NOT_FOUND)
        await expect(presets.setDefault(otherUserId, preset.id)).rejects.toMatchObject(NOT_FOUND)
        expect(await presets.list(otherUserId)).toEqual([])
        expect(await getNames()).toEqual(['Meta US'])
    })
})
