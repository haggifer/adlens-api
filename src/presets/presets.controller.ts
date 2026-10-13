import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Res, UseGuards } from '@nestjs/common'
import {
    type PresetListResponse,
    type PresetResponse,
    savePresetInputSchema,
    type SavePresetPayload,
    setDefaultPresetInputSchema,
    type SetDefaultPresetInput,
} from 'adlens-shared'
import type { Response } from 'express'
import { SessionGuard } from '../auth/session.guard'
import { CurrentUser } from '../common/current-user.decorator'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { PresetsService } from './presets.service'

@UseGuards(SessionGuard)
@Controller('v1/presets')
export class PresetsController {
    constructor(private readonly presets: PresetsService) {}

    @Get()
    async list(@CurrentUser() userId: string): Promise<PresetListResponse> {
        return { presets: await this.presets.list(userId) }
    }

    // 201 for a new preset, 200 when the save overwrote one: the web tells them apart by the status.
    @Post()
    async create(
        @CurrentUser() userId: string,
        @Body(new ZodValidationPipe(savePresetInputSchema)) input: SavePresetPayload,
        @Res({ passthrough: true }) res: Response,
    ): Promise<PresetResponse> {
        const { preset, isCreated } = await this.presets.create(userId, input)

        res.status(isCreated ? HttpStatus.CREATED : HttpStatus.OK)

        return { preset }
    }

    // Before ':id', so "default" is never read as an id.
    @Put('default')
    @HttpCode(HttpStatus.NO_CONTENT)
    async setDefault(
        @CurrentUser() userId: string,
        @Body(new ZodValidationPipe(setDefaultPresetInputSchema)) { presetId }: SetDefaultPresetInput,
    ): Promise<void> {
        await this.presets.setDefault(userId, presetId)
    }

    @Put(':id')
    async update(
        @CurrentUser() userId: string,
        @Param('id') id: string,
        @Body(new ZodValidationPipe(savePresetInputSchema)) input: SavePresetPayload,
    ): Promise<PresetResponse> {
        return { preset: await this.presets.update(userId, id, input) }
    }

    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@CurrentUser() userId: string, @Param('id') id: string): Promise<void> {
        await this.presets.remove(userId, id)
    }
}
