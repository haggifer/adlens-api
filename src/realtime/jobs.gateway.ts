import { Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets'
import type { Job } from 'adlens-shared'
import { Model } from 'mongoose'
import { Server, Socket } from 'socket.io'
import { AuthService } from '../auth/auth.service'
import { describeError } from '../common/error-message'
import { JOB_MODEL, type JobDoc } from '../database/job.doc'
import { IN_PROGRESS_STATUSES } from '../jobs/job-status'

// Enough for a few open tabs; counted per API instance.
export const MAX_SOCKETS_PER_USER = 3

const roomOf = (userId: string) => `user:${userId}`

// Authenticates the socket handshake with the same session cookie check as the HTTP guard, then joins the socket to a
// per-user room so job updates only reach their owner. CORS comes from the configured IoAdapter (realtime-io.adapter).
// Cloud Run bills an instance for as long as any socket to it is open, so a socket is only let in while its user has an
// analysis in progress, and closed once the last one ends: nobody, script or idle tab, can hold one open for nothing.
@WebSocketGateway()
export class JobsGateway implements OnGatewayConnection {
    @WebSocketServer() private readonly server: Server
    private readonly logger = new Logger(JobsGateway.name)

    constructor(
        private readonly auth: AuthService,
        @InjectModel(JOB_MODEL) private readonly jobs: Model<JobDoc>,
    ) {}

    // Nest doesn't await this, so a rejection here would be unhandled and end the process.
    async handleConnection(client: Socket): Promise<void> {
        try {
            const isAdmitted = await this.admit(client)

            if (!isAdmitted) {
                client.disconnect(true)
            }
        } catch (err) {
            this.logger.error(`socket handshake failed: ${describeError(err)}`)
            client.disconnect(true)
        }
    }

    // Joins before checking: an update published before the join can't reach the socket, so checking afterwards
    // guarantees a socket that stays sees the job's next update. The room count then includes this socket.
    private async admit(client: Socket): Promise<boolean> {
        const userId = await this.auth.getUserId(client.handshake.headers)

        if (!userId) {
            return false
        }

        const room = roomOf(userId)

        await client.join(room)

        const [isRunning, sockets] = await Promise.all([
            this.hasJobInProgress(userId),
            this.server.in(room).fetchSockets(),
        ])

        return isRunning && sockets.length <= MAX_SOCKETS_PER_USER
    }

    // A closing socket sends what it has buffered first, so the update that ends the last running job still arrives.
    async publishJobUpdate(userId: string, job: Job): Promise<void> {
        const room = roomOf(userId)

        this.server.to(room).emit('job:updated', job)

        if (IN_PROGRESS_STATUSES.includes(job.status)) {
            return
        }

        const isRunning = await this.hasJobInProgress(userId)

        if (!isRunning) {
            this.server.in(room).disconnectSockets(true)
        }
    }

    private async hasJobInProgress(userId: string): Promise<boolean> {
        const job = await this.jobs.exists({ userId, status: { $in: IN_PROGRESS_STATUSES } })

        return job !== null
    }
}
