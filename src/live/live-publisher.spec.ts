import { Logger } from '@nestjs/common'
import { Rest } from 'ably'
import { getLiveChannel, LiveEvent } from 'adlens-shared'
import { Types } from 'mongoose'
import { DEMO_OWNER } from '../database/job.doc'
import { AblyLivePublisher, OffLivePublisher } from './live-publisher'

// A well-formed key that no Ably app has: token requests are signed locally, and every publish is stubbed.
const FAKE_KEY = 'appId.keyId:secret'
const USER = new Types.ObjectId().toString()

describe('AblyLivePublisher', () => {
    let client: Rest
    let publish: jest.Mock
    let live: AblyLivePublisher

    beforeEach(() => {
        client = new Rest({ key: FAKE_KEY })
        publish = jest.fn().mockResolvedValue(undefined)
        jest.spyOn(client.channels, 'get').mockReturnValue({ publish } as unknown as ReturnType<
            Rest['channels']['get']
        >)
        live = new AblyLivePublisher(client)
    })

    afterEach(() => {
        jest.restoreAllMocks()
    })

    it('signs a token request that lets a tab subscribe to its own channel only', async () => {
        const tokenRequest = await live.createTokenRequest(USER)

        expect(JSON.parse(tokenRequest.capability)).toEqual({ [getLiveChannel(USER)]: ['subscribe'] })
    })

    it("publishes a job's id and a presets change to the owner's channel", async () => {
        const jobId = new Types.ObjectId()

        await live.publishJob({ _id: jobId, userId: USER })
        await live.publishPresets(USER)

        expect(client.channels.get).toHaveBeenCalledWith(getLiveChannel(USER))
        expect(publish.mock.calls).toEqual([
            [LiveEvent.Job, { id: jobId.toString() }],
            [LiveEvent.Presets, undefined],
        ])
    })

    it('publishes nothing for a demo job', async () => {
        await live.publishJob({ _id: new Types.ObjectId(), userId: DEMO_OWNER })

        expect(publish).not.toHaveBeenCalled()
    })

    it('publishes nothing for a minute after a failed publish, so an unreachable Ably slows writes only once', async () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(0)

        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
        publish.mockRejectedValueOnce(new Error('Ably unavailable'))

        await live.publishPresets(USER)
        now.mockReturnValue(59_999)
        await live.publishPresets(USER)

        expect(publish).toHaveBeenCalledTimes(1)

        now.mockReturnValue(60_000)
        await live.publishPresets(USER)

        expect(publish).toHaveBeenCalledTimes(2)
    })

    it('logs a failed publish instead of failing the write', async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

        publish.mockRejectedValue(new Error('Ably unavailable'))

        await expect(live.publishPresets(USER)).resolves.toBeUndefined()
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ably unavailable'))
    })
})

describe('OffLivePublisher', () => {
    it('gives no token', async () => {
        await expect(new OffLivePublisher().createTokenRequest()).resolves.toBeNull()
    })
})
