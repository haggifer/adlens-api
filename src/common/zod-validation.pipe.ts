import { HttpStatus, PipeTransform } from '@nestjs/common'
import { RequestErrorCode } from 'adlens-shared'
import type { z } from 'zod'
import { ApiException } from './api-exception'

// Parses a request body or query against a shared Zod schema, so a client can only send allowlisted fields. The
// handler's parameter annotation carries the parsed type.
export class ZodValidationPipe implements PipeTransform {
    constructor(private readonly schema: z.ZodType) {}

    transform(value: unknown): unknown {
        const result = this.schema.safeParse(value)

        if (!result.success) {
            throw new ApiException(
                HttpStatus.BAD_REQUEST,
                RequestErrorCode.ValidationFailed,
                'Invalid request',
                result.error.issues,
            )
        }

        return result.data
    }
}
