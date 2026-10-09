import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common'
import { type ApiError, type ApiErrorCode, RequestErrorCode } from 'adlens-shared'
import type { Response } from 'express'
import { ApiException } from './api-exception'
import { describeErrorWithStack } from './error-message'

interface BodyParserError {
    status: number
    type: string
    message: string
}

const CODE_BY_STATUS: Partial<Record<HttpStatus, ApiErrorCode>> = {
    [HttpStatus.BAD_REQUEST]: RequestErrorCode.ValidationFailed,
    [HttpStatus.UNAUTHORIZED]: RequestErrorCode.Unauthenticated,
    [HttpStatus.NOT_FOUND]: RequestErrorCode.NotFound,
    [HttpStatus.TOO_MANY_REQUESTS]: RequestErrorCode.RateLimited,
    [HttpStatus.SERVICE_UNAVAILABLE]: RequestErrorCode.Unavailable,
}

// body-parser's own refusals (413 entity.too.large, 415 charset.unsupported and the like) are plain errors with a 4xx
// status and a type, not HttpExceptions; their messages are written for clients. A malformed JSON body never gets
// here as one: Nest turns it into a BadRequestException first.
const isBodyParserError = (exception: unknown): exception is BodyParserError => {
    const { status, type } = (exception ?? {}) as Partial<BodyParserError>

    return typeof type === 'string' && typeof status === 'number' && status >= 400 && status < 500
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

        if (isBodyParserError(exception)) {
            return {
                statusCode: exception.status,
                errorCode: RequestErrorCode.ValidationFailed,
                message: exception.message,
            }
        }

        this.logger.error(describeErrorWithStack(exception))

        return {
            statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
            errorCode: RequestErrorCode.Internal,
            message: 'Internal server error',
        }
    }
}
