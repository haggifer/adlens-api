import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets'
import type { Job } from 'adlens-shared'
import { Server, Socket } from 'socket.io'
import { AuthService } from '../auth/auth.service'

// Authenticates the socket handshake with the same session cookie check as the HTTP guard, then joins the socket to a
// per-user room so job updates only reach their owner. CORS comes from the configured IoAdapter (realtime-io.adapter).
@WebSocketGateway()
export class JobsGateway implements OnGatewayConnection {
    @WebSocketServer() private readonly server: Server

    constructor(private readonly auth: AuthService) {}

    async handleConnection(client: Socket): Promise<void> {
        const userId = await this.auth.getUserId(client.handshake.headers)

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
