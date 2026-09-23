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
        return super.createIOServer(port, { ...options, cors: { origin: this.webOrigin, credentials: true } })
    }
}
