import { type Job, JobStatus, VideoMimeType } from 'adlens-shared'
import { type Model, Types } from 'mongoose'
import type { Server, Socket } from 'socket.io'
import type { AuthService } from '../auth/auth.service'
import { JOB_MODEL, type JobDoc, JobSchema } from '../database/job.doc'
import { type MemoryMongo, startMemoryMongo } from '../testing/memory-mongo'
import { JobsGateway, MAX_SOCKETS_PER_USER } from './jobs.gateway'

// The real module loads Better Auth, which is ESM-only and can't run under Jest; the test passes its own fake.
jest.mock('../auth/auth.service', () => ({ AuthService: class AuthService {} }))

const USER = new Types.ObjectId().toString()
const ROOM = `user:${USER}`

interface FakeClient {
    handshake: { headers: Record<string, string> }
    join: jest.Mock
    disconnect: jest.Mock
}

describe('JobsGateway', () => {
    let mongo: MemoryMongo
    let jobs: Model<JobDoc>
    let gateway: JobsGateway
    let socketsInRoom: unknown[]
    const auth = { getUserId: jest.fn(async (): Promise<string | null> => USER) }
    const emit = jest.fn()
    const disconnectSockets = jest.fn()
    const server = {
        to: jest.fn(() => ({ emit })),
        in: jest.fn(() => ({ fetchSockets: async () => socketsInRoom, disconnectSockets })),
    }

    const createJob = (status: JobStatus) =>
        jobs.create({
            userId: USER,
            status,
            settings: { platforms: [], placements: [], markets: [] },
            file: { name: 'ad.mp4', contentType: VideoMimeType.Mp4, size: 1000, bucket: 'b', path: 'p' },
            chargedRunId: null,
            chargedIpRunId: null,
        })

    const createClient = (): FakeClient => {
        const client: FakeClient = {
            handshake: { headers: { cookie: 'session' } },
            join: jest.fn(async () => {
                socketsInRoom.push(client)
            }),
            disconnect: jest.fn(),
        }

        return client
    }

    const connect = async (client = createClient()) => {
        await gateway.handleConnection(client as unknown as Socket)

        return client
    }

    beforeAll(async () => {
        mongo = await startMemoryMongo()
        jobs = mongo.connection.model<JobDoc>(JOB_MODEL, JobSchema)
        gateway = new JobsGateway(auth as unknown as AuthService, jobs)
        Object.assign(gateway, { server: server as unknown as Server })
    })

    beforeEach(async () => {
        socketsInRoom = []
        jest.clearAllMocks()
        auth.getUserId.mockResolvedValue(USER)
        await jobs.deleteMany({})
    })

    afterAll(async () => {
        await mongo.stop()
    })

    describe('handleConnection', () => {
        it('lets a user in while one of their analyses is in progress', async () => {
            await createJob(JobStatus.Analyzing)

            const client = await connect()

            expect(client.join).toHaveBeenCalledWith(ROOM)
            expect(client.disconnect).not.toHaveBeenCalled()
        })

        it('turns away a user with nothing in progress, since an open socket keeps an instance billed', async () => {
            await createJob(JobStatus.Analyzed)
            await createJob(JobStatus.Pending)

            const client = await connect()

            expect(client.disconnect).toHaveBeenCalledWith(true)
        })

        it('checks for a running job only after joining, so the update that ends it is never missed', async () => {
            const job = await createJob(JobStatus.Analyzing)
            const client = createClient()

            // The final update is published while the socket is joining: it can't reach the socket, so the socket
            // must see the finished job and leave instead of waiting in the room forever.
            client.join.mockImplementation(async () => {
                socketsInRoom.push(client)
                await jobs.updateOne({ _id: job._id }, { status: JobStatus.Analyzed })
            })

            await connect(client)

            expect(client.disconnect).toHaveBeenCalledWith(true)
        })

        it('turns away a socket without a session', async () => {
            auth.getUserId.mockResolvedValue(null)

            const client = await connect()

            expect(client.join).not.toHaveBeenCalled()
            expect(client.disconnect).toHaveBeenCalledWith(true)
        })

        it('turns away a socket past the per-user limit', async () => {
            await createJob(JobStatus.Queued)
            socketsInRoom = Array.from({ length: MAX_SOCKETS_PER_USER }, () => ({}))

            const client = await connect()

            expect(client.disconnect).toHaveBeenCalledWith(true)
        })

        it('lets in the last socket the per-user limit allows', async () => {
            await createJob(JobStatus.Queued)
            socketsInRoom = Array.from({ length: MAX_SOCKETS_PER_USER - 1 }, () => ({}))

            const client = await connect()

            expect(client.disconnect).not.toHaveBeenCalled()
        })

        it('closes the socket instead of crashing the process when the session lookup fails', async () => {
            auth.getUserId.mockRejectedValue(new Error('database unavailable'))

            const client = await connect()

            expect(client.disconnect).toHaveBeenCalledWith(true)
        })

        it('closes the socket instead of crashing the process when the job lookup fails', async () => {
            const exists = jest.spyOn(jobs, 'exists').mockRejectedValueOnce(new Error('database unavailable'))

            const client = await connect()

            expect(client.disconnect).toHaveBeenCalledWith(true)
            exists.mockRestore()
        })
    })

    describe('publishJobUpdate', () => {
        const update = (status: JobStatus) => ({ id: 'job-1', status }) as Job

        it('delivers an update and keeps the sockets while the job is still running', async () => {
            await createJob(JobStatus.Analyzing)

            await gateway.publishJobUpdate(USER, update(JobStatus.Analyzing))

            expect(server.to).toHaveBeenCalledWith(ROOM)
            expect(emit).toHaveBeenCalledWith('job:updated', update(JobStatus.Analyzing))
            expect(disconnectSockets).not.toHaveBeenCalled()
        })

        it("closes the user's sockets after delivering the update that ends their last running job", async () => {
            await createJob(JobStatus.Analyzed)

            await gateway.publishJobUpdate(USER, update(JobStatus.Analyzed))

            expect(emit).toHaveBeenCalledWith('job:updated', update(JobStatus.Analyzed))
            expect(disconnectSockets).toHaveBeenCalledWith(true)
            expect(emit.mock.invocationCallOrder[0]).toBeLessThan(disconnectSockets.mock.invocationCallOrder[0])
        })

        it('keeps the sockets while another of their jobs is still running', async () => {
            await createJob(JobStatus.Queued)

            await gateway.publishJobUpdate(USER, update(JobStatus.Error))

            expect(disconnectSockets).not.toHaveBeenCalled()
        })
    })
})
