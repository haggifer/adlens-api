import type { INestApplicationContext } from '@nestjs/common'
import { IoAdapter } from '@nestjs/platform-socket.io'
import type { ServerOptions } from 'socket.io'

// Socket.IO with the same single allowed origin as HTTP CORS; the gateway decorator can't read config itself.
export class RealtimeIoAdapter extends IoAdapter {
    constructor(
        app: INestApplicationContext,
        private readonly webOrigin: string,
    ) {
        super(app)
    }

    createIOServer(port: number, options?: ServerOptions) {
        // WebSocket only, like the web client: long-polling would keep an HTTP request open on Cloud Run between polls.
        return super.createIOServer(port, {
            ...options,
            transports: ['websocket'],
            cors: { origin: this.webOrigin, credentials: true },
        })
    }
}
