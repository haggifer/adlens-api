import { Injectable } from '@nestjs/common'
import { InjectConnection } from '@nestjs/mongoose'
import type { AdminJob, AdminUser } from 'adlens-shared'
import type { Connection } from 'mongoose'
import { JOB_COLLECTION } from '../database/job.doc'
import { SAMPLE_COLLECTION, type StoredSample } from '../database/sample.doc'
import { USER_COLLECTION } from '../database/user.doc'
import {
    getSampleObjectIds,
    JOB_PROJECTION,
    type JobRecord,
    SAMPLE_TITLE_PROJECTION,
    toAdminJob,
    toAdminUser,
    USER_PROJECTION,
    type UserRecord,
} from './admin-records'

type SampleTitleRecord = Pick<StoredSample, '_id' | 'title'>

// Every job and user, newest first, for the maintainer's admin page. Unpaginated: fine at today's volume.
@Injectable()
export class AdminService {
    constructor(@InjectConnection() private readonly connection: Connection) {}

    async listJobs(): Promise<AdminJob[]> {
        const records = await this.findJobs()
        const sampleTitles = await this.getSampleTitles(records)

        return records.map((record) => toAdminJob(record, sampleTitles))
    }

    async listUsers(): Promise<AdminUser[]> {
        const records = await this.findUsers()

        return records.map(toAdminUser)
    }

    private findJobs(): Promise<JobRecord[]> {
        return this.connection
            .collection<JobRecord>(JOB_COLLECTION)
            .find({}, { projection: JOB_PROJECTION })
            .sort({ _id: -1 })
            .toArray()
    }

    private findUsers(): Promise<UserRecord[]> {
        return this.connection
            .collection<UserRecord>(USER_COLLECTION)
            .find({}, { projection: USER_PROJECTION })
            .sort({ _id: -1 })
            .toArray()
    }

    private async getSampleTitles(jobs: JobRecord[]): Promise<Map<string, string>> {
        const samples = await this.connection
            .collection<SampleTitleRecord>(SAMPLE_COLLECTION)
            .find({ _id: { $in: getSampleObjectIds(jobs) } }, { projection: SAMPLE_TITLE_PROJECTION })
            .toArray()

        return new Map(samples.map((sample) => [sample._id.toString(), sample.title]))
    }
}
