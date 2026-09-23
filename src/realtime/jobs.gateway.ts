import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets'
import type { Job } from 'adlens-shared'
import type { IncomingHttpHeaders } from 'node:http'
import { Server, Socket } from 'socket.io'
import { AuthService } from '../auth/auth.service'

// Authenticates the socket handshake with the same session check as the HTTP guard, then joins the socket to a
// per-user room so job updates only reach their owner. CORS comes from the configured IoAdapter (realtime-io.adapter).
@WebSocketGateway()
export class JobsGateway implements OnGatewayConnection {
    @WebSocketServer() private readonly server: Server

    constructor(private readonly auth: AuthService) {}

    async handleConnection(client: Socket): Promise<void> {
        const authToken = client.handshake.auth?.token
        const header = client.handshake.headers.authorization
        const token =
            (typeof authToken === 'string' && authToken) ||
            (header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null)

        if (!token) {
            client.disconnect()
            return
        }

        const userId = await this.auth.getUserId({ authorization: `Bearer ${token}` } as IncomingHttpHeaders)

        if (!userId) {
            client.disconnect()
            return
        }

        await client.join(`user:${userId}`)
    }

    emitJobUpdated(userId: string, job: Job): void {
        this.server.to(`user:${userId}`).emit('job:updated', job)
    }
}
