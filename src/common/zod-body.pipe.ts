import { BadRequestException, PipeTransform } from '@nestjs/common'

// Structural shape of what we use from a Zod schema. Duck-typed on purpose: the schemas come from the
// shared package (built against its own Zod copy), so importing Zod's own types here would make the
// two copies clash. This also sidesteps the "excessively deep instantiation" from inferring the output.
interface Parsable {
    safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues: unknown } }
}

// Validates a request body against a shared Zod schema, so a client can only set allowlisted fields —
// the mass-assignment guard the old Firestore rules gave us. The handler's parameter annotation carries
// the concrete type; this just parses at runtime.
export class ZodBody implements PipeTransform {
    constructor(private readonly schema: Parsable) {}

    transform(value: unknown): unknown {
        const result = this.schema.safeParse(value)

        if (!result.success) {
            throw new BadRequestException({ message: 'Invalid request body', issues: result.error.issues })
        }

        return result.data
    }
}
