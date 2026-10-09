import type { INestApplicationContext } from '@nestjs/common'
import { IoAdapter } from '@nestjs/platform-socket.io'
import type { IncomingMessage } from 'node:http'
import type { ServerOptions } from 'socket.io'

// Socket.IO with the same allowed origins as HTTP CORS; the gateway decorator can't read config itself.
export class RealtimeIoAdapter extends IoAdapter {
    constructor(
        app: INestApplicationContext,
        private readonly webOrigins: string[],
    ) {
        super(app)
    }

    createIOServer(port: number, options?: ServerOptions) {
        // WebSocket only, like the web client: long-polling would keep an HTTP request open on Cloud Run between polls.
        return super.createIOServer(port, {
            ...options,
            transports: ['websocket'],
            cors: { origin: this.webOrigins, credentials: true },
            // CORS never applies to a WebSocket, so without this any site could open a socket that the browser
            // authenticates with the session cookie. A missing Origin is refused too: browsers always send one, AdLens
            // has no other socket client, and a script outside a browser could send any Origin anyway.
            allowRequest: (req: IncomingMessage, callback: (err: string | null, isAllowed: boolean) => void) => {
                const isAllowed = req.headers.origin !== undefined && this.webOrigins.includes(req.headers.origin)

                callback(isAllowed ? null : 'Origin not allowed', isAllowed)
            },
        })
    }
}
