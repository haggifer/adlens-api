import { Logger } from '@nestjs/common'
import { AnalysisDispatcher } from './analysis/dispatch/analysis-dispatcher'
import { warmUpFirstAnalysis } from './api-warm-up'
import { MediaProber } from './jobs/verification/media-prober'
import { StorageService } from './storage/storage.service'

const fakeApp = (steps: { prober: jest.Mock; dispatcher: jest.Mock; signing: jest.Mock }) => ({
    get: (token: unknown) => {
        switch (token) {
            case MediaProber:
                return { warmUp: steps.prober }
            case AnalysisDispatcher:
                return { warmUp: steps.dispatcher }
            case StorageService:
                return { warmUpSigning: steps.signing }
            default:
                throw new Error('unexpected provider')
        }
    },
})

describe('warmUpFirstAnalysis', () => {
    let warn: jest.SpyInstance

    beforeEach(() => {
        warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    })

    afterEach(() => {
        jest.restoreAllMocks()
    })

    it('runs ffprobe, sets up the Cloud Run client and signs once', async () => {
        const steps = {
            prober: jest.fn(async () => {}),
            dispatcher: jest.fn(async () => {}),
            signing: jest.fn(async () => {}),
        }

        await warmUpFirstAnalysis(fakeApp(steps) as never)

        expect(steps.prober).toHaveBeenCalledTimes(1)
        expect(steps.dispatcher).toHaveBeenCalledTimes(1)
        expect(steps.signing).toHaveBeenCalledTimes(1)
        expect(warn).not.toHaveBeenCalled()
    })

    it('logs a failing step once and still runs the others, without throwing', async () => {
        const steps = {
            prober: jest.fn(async () => {
                throw new Error('ffprobe missing')
            }),
            dispatcher: jest.fn(() => {
                throw new Error('no credentials')
            }),
            signing: jest.fn(async () => {}),
        }

        await expect(warmUpFirstAnalysis(fakeApp(steps) as never)).resolves.toBeUndefined()

        expect(steps.signing).toHaveBeenCalledTimes(1)
        expect(warn).toHaveBeenCalledTimes(2)
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('ffprobe missing'))
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('no credentials'))
    })

    it('stops waiting for a step that hangs', async () => {
        const steps = {
            prober: jest.fn(() => new Promise<void>(() => {})),
            dispatcher: jest.fn(async () => {}),
            signing: jest.fn(async () => {}),
        }

        await expect(warmUpFirstAnalysis(fakeApp(steps) as never, 10)).resolves.toBeUndefined()

        expect(steps.dispatcher).toHaveBeenCalledTimes(1)
        expect(steps.signing).toHaveBeenCalledTimes(1)
        expect(warn).toHaveBeenCalledTimes(1)
    })
})
