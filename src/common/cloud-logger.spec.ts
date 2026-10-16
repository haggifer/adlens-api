import { readLogFormat } from '../config/log-format'
import { CloudLogger, createLogger } from './cloud-logger'

describe('CloudLogger', () => {
    let lines: string[]

    const logged = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>)

    beforeEach(() => {
        lines = []
        jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            lines.push(String(chunk))
            return true
        })
        jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
            lines.push(String(chunk))
            return true
        })
    })

    afterEach(() => {
        jest.restoreAllMocks()
    })

    it('writes one JSON line per entry, with the severity Cloud Logging reads', () => {
        const logger = new CloudLogger()

        logger.log('job 1: analyzed', 'Worker')
        logger.warn('job 2 expired while queued', 'JobLifecycle')
        logger.debug('probe done', 'VideoVerifier')
        logger.fatal('cannot start', 'Bootstrap')

        expect(lines.every((line) => line.endsWith('\n') && !line.slice(0, -1).includes('\n'))).toBe(true)
        expect(logged()).toEqual([
            { severity: 'INFO', message: 'job 1: analyzed', context: 'Worker' },
            { severity: 'WARNING', message: 'job 2 expired while queued', context: 'JobLifecycle' },
            { severity: 'DEBUG', message: 'probe done', context: 'VideoVerifier' },
            { severity: 'CRITICAL', message: 'cannot start', context: 'Bootstrap' },
        ])
    })

    it('puts an error stack where Error Reporting finds it', () => {
        const logger = new CloudLogger()

        logger.error('could not send an auth email', 'Error: boom\n    at send (mailer.ts:1:1)', 'Auth')

        expect(logged()).toEqual([
            {
                severity: 'ERROR',
                message: 'could not send an auth email',
                context: 'Auth',
                stack_trace: 'Error: boom\n    at send (mailer.ts:1:1)',
            },
        ])
    })
})

describe('createLogger', () => {
    it('logs JSON only when asked to, and keeps Nest’s readable default otherwise', () => {
        expect(createLogger(readLogFormat({ LOG_FORMAT: 'json' }))).toBeInstanceOf(CloudLogger)
        expect(createLogger(readLogFormat({}))).toBeUndefined()
    })
})
