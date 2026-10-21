import { type INestApplicationContext, Logger } from '@nestjs/common'
import { AnalysisDispatcher } from './analysis/dispatch/analysis-dispatcher'
import { describeError } from './common/error-message'
import { MediaProber } from './jobs/verification/media-prober'
import { StorageService } from './storage/storage.service'

type WarmUpSteps = Record<string, () => Promise<unknown>>

// The first-use costs together take about 1 to 2 s; whatever is still running then finishes in the background rather
// than delay the instance any longer.
const WARM_UP_TIMEOUT_MS = 3000

const logger = new Logger('WarmUp')

const runStep = async (name: string, step: () => Promise<unknown>): Promise<void> => {
    try {
        await step()
    } catch (err) {
        logger.warn(`${name} could not be warmed up: ${describeError(err)}`)
    }
}

// Never throws and waits at most timeoutMs: a step that fails or hangs only leaves its cost to the first analysis.
const runSteps = async (steps: WarmUpSteps, timeoutMs: number): Promise<void> => {
    let timer: NodeJS.Timeout | undefined

    const done = Promise.all(Object.entries(steps).map(([name, step]) => runStep(name, step))).then(() => true)
    const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
    })

    const isDone = await Promise.race([done, timedOut])

    clearTimeout(timer)

    if (!isDone) {
        logger.warn(`still warming up after ${timeoutMs} ms; starting without waiting`)
    }
}

// Pays, in parallel while the API starts, what an instance's first analysis start would otherwise pay once: the first
// ffprobe run, the Cloud Run client's setup and the first storage signature.
export const warmUpFirstAnalysis = (
    app: Pick<INestApplicationContext, 'get'>,
    timeoutMs = WARM_UP_TIMEOUT_MS,
): Promise<void> =>
    runSteps(
        {
            ffprobe: () => app.get(MediaProber).warmUp(),
            'Cloud Run client': () => app.get(AnalysisDispatcher).warmUp(),
            'storage signing': () => app.get(StorageService).warmUpSigning(),
        },
        timeoutMs,
    )
