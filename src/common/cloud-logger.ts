import { ConsoleLogger, type LoggerService, type LogLevel } from '@nestjs/common'
import type { LogFormat } from '../config/log-format'

// https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#LogSeverity
const SEVERITY: Record<LogLevel, string> = {
    verbose: 'DEBUG',
    debug: 'DEBUG',
    log: 'INFO',
    warn: 'WARNING',
    error: 'ERROR',
    fatal: 'CRITICAL',
}

interface JsonLogOptions {
    context: string
    logLevel: LogLevel
    writeStreamType?: 'stdout' | 'stderr'
    errorStack?: unknown
}

// Nest's JSON mode, reshaped for Cloud Logging, which reads one JSON object per line: `severity` sets the entry's
// level (Nest writes `level`, which Cloud Logging ignores), and `stack_trace` is where Error Reporting looks for a
// stack. Cloud Logging stamps the time itself, so Nest's timestamp and pid are left out.
export class CloudLogger extends ConsoleLogger {
    constructor() {
        super({ json: true })
    }

    protected printAsJson(message: unknown, { context, logLevel, writeStreamType, errorStack }: JsonLogOptions): void {
        const entry = {
            severity: SEVERITY[logLevel],
            message,
            ...(context && { context }),
            ...(errorStack !== undefined && { stack_trace: errorStack }),
        }

        process[writeStreamType ?? 'stdout'].write(`${JSON.stringify(entry, this.stringifyReplacer)}\n`)
    }
}

// undefined keeps Nest's default, readable logger for local runs.
export const createLogger = (format: LogFormat): LoggerService | undefined =>
    format === 'json' ? new CloudLogger() : undefined
