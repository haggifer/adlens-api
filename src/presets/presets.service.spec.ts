import { HttpStatus } from '@nestjs/common'
import {
    type AnalysisSettings,
    Market,
    MAX_PRESETS,
    Placement,
    Platform,
    PRESET_NAME_MAX_LENGTH,
    RequestErrorCode,
    type SavePresetPayload,
} from 'adlens-shared'
import { Types } from 'mongoose'
import { ApiException } from '../common/api-exception'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { USER_PRESETS_COLLECTION, type UserPresetsDoc } from '../database/user-presets.doc'
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

    const userPresetDocs = () => mongo.connection.collection<UserPresetsDoc>(USER_PRESETS_COLLECTION)

    const input = (name: string, fields: Partial<SavePresetPayload> = {}): SavePresetPayload => ({
        name,
        settings: META_US,
        ...fields,
    })

    const createFor = async (owner: string, name: string, fields: Partial<SavePresetPayload> = {}) => {
        const { preset } = await presets.create(owner, input(name, fields))

        return preset
    }

    const create = (name: string, fields: Partial<SavePresetPayload> = {}) => createFor(userId, name, fields)

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
        await userPresetDocs().deleteMany({})
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

    it('refuses a name that differs only in inner whitespace or Unicode compatibility form', async () => {
        await create('Meta US')

        await expect(presets.create(userId, input('meta   us'))).rejects.toMatchObject(NAME_TAKEN)
        await expect(presets.create(userId, input('Ｍeta US'))).rejects.toMatchObject(NAME_TAKEN)
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

        await userPresetDocs().updateOne({ _id: userId }, { $set: { 'presets.0.usageCount': 3 } })

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

        await userPresetDocs().updateOne(
            { _id: userId },
            { $set: { 'presets.0.usageCount': 5, 'presets.1.usageCount': 2 } },
        )

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

    // Unchecking "Select as default" clears the default only when it is this preset; the overwritten preset's default
    // still moves to it.
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

    it('keeps the default on an overwrite on create without isDefault, and clears it with isDefault false', async () => {
        const preset = await create('Meta US', { isDefault: true })

        const kept = await presets.create(userId, input('Meta US', { settings: TIKTOK_EU, overwrite: true }))

        expect(kept.preset.isDefault).toBe(true)
        expect(await getDefaultId()).toBe(preset.id)

        const cleared = await presets.create(userId, input('Meta US', { overwrite: true, isDefault: false }))

        expect(cleared.preset.isDefault).toBe(false)
        expect(await getDefaultId()).toBeNull()
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
        expect((await userPresetDocs().findOne({ _id: userId }))?.defaultPresetId).toBeNull()
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

    describe('transfer', () => {
        let anonymousId: string

        beforeEach(() => {
            anonymousId = new Types.ObjectId().toString()
        })

        it('gives an account without a document all the presets and the anonymous default', async () => {
            const meta = await createFor(anonymousId, 'Meta US', { isDefault: true })

            await createFor(anonymousId, 'TikTok EU', { settings: TIKTOK_EU })

            await presets.transfer(anonymousId, userId)

            const moved = await presets.list(userId)

            expect(moved.map((preset) => preset.name)).toEqual(['Meta US', 'TikTok EU'])
            expect(moved.map((preset) => preset.id)[0]).toBe(meta.id)
            expect(await getDefaultId()).toBe(meta.id)
            expect(moved[1].settings).toEqual(TIKTOK_EU)
        })

        it('keeps the usage of a moved preset', async () => {
            const meta = await createFor(anonymousId, 'Meta US')

            await presets.recordUse(anonymousId, meta.id, META_US)
            await presets.transfer(anonymousId, userId)

            expect((await presets.list(userId))[0]).toMatchObject({ id: meta.id, usageCount: 1 })
        })

        it('numbers clashing names, ignoring case, and skips a number already taken', async () => {
            await create('Meta US')
            await create('meta us (2)')
            await createFor(anonymousId, 'META US')
            await createFor(anonymousId, 'Meta US (3)')
            await createFor(anonymousId, 'Fresh')

            await presets.transfer(anonymousId, userId)

            expect(await getNames()).toEqual(['Meta US', 'meta us (2)', 'META US (4)', 'Meta US (3)', 'Fresh'])
        })

        it("numbers only the names that clash with the account, and never onto another moved preset's name", async () => {
            await create('Meta US')
            await createFor(anonymousId, 'Meta US')
            await createFor(anonymousId, 'Meta US (2)')

            await presets.transfer(anonymousId, userId)

            expect(await getNames()).toEqual(['Meta US', 'Meta US (3)', 'Meta US (2)'])
        })

        it('keeps a renamed name within the name limit', async () => {
            const longName = 'x'.repeat(PRESET_NAME_MAX_LENGTH)

            await create(longName)
            await createFor(anonymousId, longName)

            await presets.transfer(anonymousId, userId)

            const names = await getNames()

            expect(names).toEqual([longName, `${'x'.repeat(PRESET_NAME_MAX_LENGTH - 4)} (2)`])
            expect(names.every((name) => name.length <= PRESET_NAME_MAX_LENGTH)).toBe(true)
        })

        it('trims the end of a name cut short for its number', async () => {
            const longName = `${'x'.repeat(PRESET_NAME_MAX_LENGTH - 5)} y`.padEnd(PRESET_NAME_MAX_LENGTH, 'z')

            await create(longName)
            await createFor(anonymousId, longName)

            await presets.transfer(anonymousId, userId)

            const [, renamed] = await getNames()

            expect(renamed).toBe(`${'x'.repeat(PRESET_NAME_MAX_LENGTH - 5)} (2)`)
        })

        it('never cuts an emoji in half when cutting a name short for its number', async () => {
            const base = 'x'.repeat(PRESET_NAME_MAX_LENGTH - 5)
            const longName = `${base}\u{1F600}\u{1F600}`

            await create(longName)
            await createFor(anonymousId, longName)

            await presets.transfer(anonymousId, userId)

            const [, renamed] = await getNames()

            expect(renamed).toBe(`${base} (2)`)
        })

        it('never cuts a flag, two code points, in half either', async () => {
            const base = 'x'.repeat(PRESET_NAME_MAX_LENGTH - 6)
            const longName = `${base}\u{1F1FA}\u{1F1E6}`

            await create(longName)
            await createFor(anonymousId, longName)

            await presets.transfer(anonymousId, userId)

            const [, renamed] = await getNames()

            expect(renamed).toBe(`${base} (2)`)
        })

        it('moves every preset once when two links for one anonymous user run at the same time', async () => {
            await create('Meta US')
            await create('Own')
            await createFor(anonymousId, 'Meta US', { isDefault: true })
            await createFor(anonymousId, 'Other')
            await createFor(anonymousId, 'Third')

            const settled = await Promise.allSettled([
                presets.transfer(anonymousId, userId),
                presets.transfer(anonymousId, userId),
                presets.transfer(anonymousId, userId),
            ])

            const moved = await presets.list(userId)
            const stored = await userPresetDocs().findOne({ _id: userId })

            expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled'])
            expect(moved).toHaveLength(5)
            expect(new Set(moved.map((preset) => preset.id)).size).toBe(5)
            expect(new Set(stored?.presets.map((preset) => preset.nameKey)).size).toBe(5)
            expect(await userPresetDocs().findOne({ _id: anonymousId })).toBeNull()
        })

        it("keeps the account's own default when it has one", async () => {
            const own = await create('Own', { isDefault: true })

            await createFor(anonymousId, 'Anonymous', { isDefault: true })
            await presets.transfer(anonymousId, userId)

            expect(await getDefaultId()).toBe(own.id)
        })

        it("takes the anonymous default when the account's presets have none", async () => {
            await create('Own')

            const anonymous = await createFor(anonymousId, 'Anonymous', { isDefault: true })

            await presets.transfer(anonymousId, userId)

            expect(await getDefaultId()).toBe(anonymous.id)
        })

        it('leaves the account without a default when neither side has one', async () => {
            await create('Own')
            await createFor(anonymousId, 'Anonymous')

            await presets.transfer(anonymousId, userId)

            expect(await getDefaultId()).toBeNull()
        })

        it("doesn't apply the limit: 19 and 5 become 24", async () => {
            await fill(19)

            for (let i = 0; i < 5; i++) {
                await createFor(anonymousId, `Anonymous ${i}`)
            }

            await presets.transfer(anonymousId, userId)

            expect(await presets.list(userId)).toHaveLength(24)
        })

        it('stops at twice the limit, moving the most recently used or edited presets in their own order', async () => {
            const earlierAnonymousId = new Types.ObjectId().toString()
            const later = new Date(Date.now() + 60_000)
            const recentNames = ['Late 1', 'Late 3', 'Late 4', 'Late 6', 'Late 7']

            await fill(MAX_PRESETS)

            for (let i = 0; i < MAX_PRESETS - 5; i++) {
                await createFor(earlierAnonymousId, `Early ${i}`)
            }

            await presets.transfer(earlierAnonymousId, userId)

            const late = []

            for (let i = 0; i < 8; i++) {
                late.push(await createFor(anonymousId, `Late ${i}`, { isDefault: i === 0 }))
            }

            for (const [i, preset] of late.entries()) {
                if (recentNames.includes(preset.name)) {
                    await presets.recordUse(anonymousId, preset.id, META_US, new Date(later.getTime() + i))
                }
            }

            await presets.transfer(anonymousId, userId)

            const names = await getNames()

            expect(names).toHaveLength(MAX_PRESETS * 2)
            expect(names.slice(-5)).toEqual(recentNames)
            expect(await getDefaultId()).toBeNull()
            expect(await userPresetDocs().findOne({ _id: anonymousId })).toBeNull()
        })

        it('moves nothing twice when run again', async () => {
            await create('Meta US')
            await createFor(anonymousId, 'Meta US', { isDefault: true })
            await createFor(anonymousId, 'Other')

            await presets.transfer(anonymousId, userId)
            await presets.transfer(anonymousId, userId)

            expect(await getNames()).toEqual(['Meta US', 'Meta US (2)', 'Other'])
        })

        it('finishes a transfer that stopped before it deleted the anonymous document', async () => {
            await create('Meta US')
            await createFor(anonymousId, 'Meta US', { isDefault: true })
            await createFor(anonymousId, 'Other')

            const left = await userPresetDocs().findOne({ _id: anonymousId })

            await presets.transfer(anonymousId, userId)

            const moved = await presets.list(userId)

            await userPresetDocs().insertOne(left!)
            await presets.transfer(anonymousId, userId)

            expect(await presets.list(userId)).toEqual(moved)
            expect(await userPresetDocs().findOne({ _id: anonymousId })).toBeNull()
        })

        it('deletes the anonymous document', async () => {
            await createFor(anonymousId, 'Meta US')

            await presets.transfer(anonymousId, userId)

            expect(await userPresetDocs().findOne({ _id: anonymousId })).toBeNull()
            expect(await presets.list(anonymousId)).toEqual([])
        })

        it('does nothing when the anonymous user has no document', async () => {
            await create('Own', { isDefault: true })

            await presets.transfer(anonymousId, userId)

            expect(await getNames()).toEqual(['Own'])
            expect(await userPresetDocs().countDocuments()).toBe(1)
        })

        it("doesn't create a document for the account when there is nothing to move", async () => {
            await presets.transfer(anonymousId, userId)

            expect(await userPresetDocs().countDocuments()).toBe(0)
        })
    })

    describe('purge', () => {
        it("deletes the user's document and leaves other users' presets", async () => {
            const otherUserId = new Types.ObjectId().toString()

            await create('Meta US')
            await createFor(otherUserId, 'Other')

            await presets.purge(userId)

            expect(await userPresetDocs().findOne({ _id: userId })).toBeNull()
            expect(await presets.list(otherUserId)).toHaveLength(1)
        })

        it('does nothing for a user without presets', async () => {
            await expect(presets.purge(userId)).resolves.toBeUndefined()
        })
    })
})
