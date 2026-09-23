import { Model } from 'mongoose'

import { QuotaService } from '../quota/quota.service'
import { JobDocument } from '../schemas/job.schema'
import { StorageService } from '../storage/storage.service'
import { AnalysisRunner } from './analysis-runner.service'
import { analyzeVideo } from './analyze'

jest.mock('./analyze')

describe('AnalysisRunner', () => {
    it('is idempotent: returns without re-analyzing when the job is already analyzed', async () => {
        const updateOne = jest.fn()
        const model = {
            findOne: jest.fn().mockResolvedValue({
                _id: 'j1',
                userId: 'u1',
                status: 'analyzed',
                file: { bucket: 'b', path: 'p', contentType: 'video/mp4', size: 1 },
            }),
            updateOne,
        } as unknown as Model<JobDocument>
        const storage = { saveJson: jest.fn() } as unknown as StorageService
        const quota = { refund: jest.fn() } as unknown as QuotaService
        const runner = new AnalysisRunner(model, storage, quota)

        await runner.run('u1', 'j1')

        expect(analyzeVideo).not.toHaveBeenCalled()
        expect(updateOne).not.toHaveBeenCalled()
    })
})
