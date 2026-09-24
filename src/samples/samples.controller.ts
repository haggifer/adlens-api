import { Controller, Get } from '@nestjs/common'
import type { SampleListResponse } from 'adlens-shared'
import { SamplesService } from './samples.service'

// Public: anyone can browse the sample ads; analyzing one needs a session (POST /v1/jobs/from-sample).
@Controller('v1/samples')
export class SamplesController {
    constructor(private readonly samples: SamplesService) {}

    @Get()
    list(): Promise<SampleListResponse> {
        return this.samples.list()
    }
}
