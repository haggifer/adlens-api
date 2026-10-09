import type { Connection } from 'mongoose'
import { EventEmitter } from 'node:events'
import { JobEventsService } from './job-events.service'
import type { JobsGateway } from './jobs.gateway'

// The real gateway module loads Better Auth, which is ESM-only and can't run under Jest; the test passes its own fake.
jest.mock('./jobs.gateway', () => ({ JobsGateway: class JobsGateway {} }))

const RESUME_TOKEN = { _data: 'token-1' }

class FakeStream extends EventEmitter {
    close = jest.fn(async () => undefined)
}

const mongoError = (message: string, code: number) => Object.assign(new Error(message), { code })

describe('JobEventsService', () => {
    let streams: FakeStream[]
    let watch: jest.Mock
    let service: JobEventsService

    const lastOptions = () => watch.mock.calls.at(-1)?.[1] as Record<string, unknown>

    const reopen = async () => {
        await jest.runOnlyPendingTimersAsync()
    }

    // Until the restart has closed the broken stream and is waiting to reopen.
    const waitForRestartTimer = async () => {
        for (let i = 0; i < 10 && jest.getTimerCount() === 0; i++) {
            await Promise.resolve()
        }

        expect(jest.getTimerCount()).toBe(1)
    }

    beforeEach(() => {
        jest.useFakeTimers()
        streams = []
        watch = jest.fn(() => {
            const stream = new FakeStream()

            streams.push(stream)
            return stream
        })

        const conn = { readyState: 1, db: { collection: () => ({ watch }) } } as unknown as Connection
        const gateway = { publishJobUpdate: jest.fn(async () => undefined) } as unknown as JobsGateway

        service = new JobEventsService(conn, gateway)
        service.onModuleInit()
        streams[0].emit('change', { _id: RESUME_TOKEN })
    })

    afterEach(async () => {
        await service.onModuleDestroy()
        jest.useRealTimers()
    })

    it('reopens from the last seen update after an error, so none is lost', async () => {
        streams[0].emit('error', mongoError('connection reset', 6))
        await reopen()

        expect(watch).toHaveBeenCalledTimes(2)
        expect(lastOptions()).toMatchObject({ resumeAfter: RESUME_TOKEN })
    })

    it.each([
        ['its history is gone', 286],
        ['the token is invalid', 260],
        ['the stream is fatally broken', 280],
    ])('reopens from now when it can never resume from the token (%s)', async (_reason, code) => {
        streams[0].emit('error', mongoError('cannot resume', code))
        await reopen()

        expect(watch).toHaveBeenCalledTimes(2)
        expect(lastOptions()).not.toHaveProperty('resumeAfter')
    })

    it('never reopens once the module is being destroyed, even when an error came just before', async () => {
        streams[0].emit('error', mongoError('connection reset', 6))
        await waitForRestartTimer()

        await service.onModuleDestroy()
        await jest.runAllTimersAsync()

        expect(watch).toHaveBeenCalledTimes(1)
        expect(jest.getTimerCount()).toBe(0)
    })

    it('doesn’t open a stream when the database connects while the module is being destroyed', async () => {
        const watchLater = jest.fn()
        const conn = Object.assign(new EventEmitter(), {
            readyState: 0,
            db: { collection: () => ({ watch: watchLater }) },
        }) as unknown as Connection
        const later = new JobEventsService(conn, {} as JobsGateway)

        later.onModuleInit()
        await later.onModuleDestroy()
        ;(conn as unknown as EventEmitter).emit('open')

        expect(watchLater).not.toHaveBeenCalled()
    })
})
