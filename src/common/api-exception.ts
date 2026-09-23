import { HttpException, HttpStatus } from '@nestjs/common'
import type { ApiError, ApiErrorCode } from 'adlens-shared'

// An HTTP error with a stable, client-mappable code. The message is for developers; clients show their own copy.
export class ApiException extends HttpException {
    constructor(status: HttpStatus, errorCode: ApiErrorCode, message: string, issues?: unknown[]) {
        const body: ApiError = { statusCode: status, errorCode, message, ...(issues ? { issues } : {}) }

        super(body, status)
    }
}
