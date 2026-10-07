import { Controller, Get } from '@nestjs/common'
import type { DemoListResponse } from 'adlens-shared'
import { DemosService } from './demos.service'

// Public: the demo page shows finished example analyses to anyone, signed in or not.
@Controller('v1/demos')
export class DemosController {
    constructor(private readonly demos: DemosService) {}

    @Get()
    list(): Promise<DemoListResponse> {
        return this.demos.list()
    }
}
