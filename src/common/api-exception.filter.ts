import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common'
import { type ApiError, type ApiErrorCode, RequestErrorCode } from 'adlens-shared'
import type { Response } from 'express'
import { ApiException } from './api-exception'

const CODE_BY_STATUS: Partial<Record<HttpStatus, ApiErrorCode>> = {
    [HttpStatus.BAD_REQUEST]: RequestErrorCode.ValidationFailed,
    [HttpStatus.UNAUTHORIZED]: RequestErrorCode.Unauthenticated,
    [HttpStatus.NOT_FOUND]: RequestErrorCode.NotFound,
    [HttpStatus.TOO_MANY_REQUESTS]: RequestErrorCode.RateLimited,
    [HttpStatus.SERVICE_UNAVAILABLE]: RequestErrorCode.Unavailable,
}

// Gives every non-2xx HTTP response the shared ApiError shape. Unexpected errors are logged and reported as INTERNAL
// without leaking their message.
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(ApiExceptionFilter.name)

    catch(exception: unknown, host: ArgumentsHost): void {
        const response = host.switchToHttp().getResponse<Response>()
        const body = this.toBody(exception)

        response.status(body.statusCode).json(body)
    }

    private toBody(exception: unknown): ApiError {
        if (exception instanceof ApiException) {
            return exception.getResponse() as ApiError
        }

        if (exception instanceof HttpException) {
            const statusCode = exception.getStatus()

            return {
                statusCode,
                errorCode: CODE_BY_STATUS[statusCode as HttpStatus] ?? RequestErrorCode.Internal,
                message: exception.message,
            }
        }

        this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception))

        return {
            statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
            errorCode: RequestErrorCode.Internal,
            message: 'Internal server error',
        }
    }
}
