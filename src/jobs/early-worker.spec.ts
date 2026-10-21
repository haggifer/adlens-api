import { EARLY_WORKER_MARGIN_MS, isLeftToEarlyWorker } from './early-worker'

const QUEUED_AT = new Date('2026-10-21T10:00:00Z')

const deadlineAfter = (ms: number) => new Date(QUEUED_AT.getTime() + ms)

describe('isLeftToEarlyWorker', () => {
    it('leaves a job queued more than the margin before the deadline to the early worker', () => {
        expect(isLeftToEarlyWorker(deadlineAfter(EARLY_WORKER_MARGIN_MS + 1), QUEUED_AT)).toBe(true)
    })

    it('gives a job queued within the margin, at or after the deadline, or without one, a worker of its own', () => {
        expect(isLeftToEarlyWorker(deadlineAfter(EARLY_WORKER_MARGIN_MS), QUEUED_AT)).toBe(false)
        expect(isLeftToEarlyWorker(deadlineAfter(0), QUEUED_AT)).toBe(false)
        expect(isLeftToEarlyWorker(deadlineAfter(-1), QUEUED_AT)).toBe(false)
        expect(isLeftToEarlyWorker(undefined, QUEUED_AT)).toBe(false)
    })
})
