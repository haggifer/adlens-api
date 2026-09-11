import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets'
import { Server, Socket } from 'socket.io'

import { AuthService } from '../auth/auth.service'

// Authenticates the socket handshake the same way the HTTP guard does, then joins the socket to a
// per-user room so job updates only reach their owner.
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class JobsGateway implements OnGatewayConnection {
    @WebSocketServer() private readonly server: Server

    constructor(private readonly auth: AuthService) {}

    handleConnection(client: Socket): void {
        const authToken = client.handshake.auth?.token
        const header = client.handshake.headers.authorization
        const token =
            (typeof authToken === 'string' && authToken) ||
            (header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null)

        if (!token) {
            client.disconnect()
            return
        }

        try {
            const userId = this.auth.verify(token)
            void client.join(`user:${userId}`)
        } catch {
            client.disconnect()
        }
    }

    emitJobUpdated(userId: string, job: unknown): void {
        this.server.to(`user:${userId}`).emit('job:updated', job)
    }
}
