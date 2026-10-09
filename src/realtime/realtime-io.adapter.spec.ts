import { createServer, request, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server } from 'socket.io'
import { RealtimeIoAdapter } from './realtime-io.adapter'

const WEB_ORIGIN = 'https://www.useadlens.com'

// 101 when the WebSocket handshake is accepted, otherwise the status it was refused with (engine.io refuses an upgrade
// with 400 whatever the reason).
const handshakeStatus = (port: number, origin?: string) =>
    new Promise<number>((resolve, reject) => {
        const req = request({
            host: '127.0.0.1',
            port,
            path: '/socket.io/?EIO=4&transport=websocket',
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
                ...(origin ? { Origin: origin } : {}),
            },
        })

        req.on('upgrade', (_res, socket) => {
            socket.destroy()
            resolve(101)
        })
        req.on('response', (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
        })
        req.on('error', reject)
        req.end()
    })

describe('RealtimeIoAdapter', () => {
    let http: HttpServer
    let io: Server
    let port: number

    beforeAll(async () => {
        http = createServer()
        io = new RealtimeIoAdapter(http as never, [WEB_ORIGIN]).createIOServer(0)
        await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
        port = (http.address() as AddressInfo).port
    })

    afterAll(async () => {
        await io.close()
    })

    it('accepts a WebSocket handshake from the web app', async () => {
        expect(await handshakeStatus(port, WEB_ORIGIN)).toBe(101)
    })

    it('refuses a handshake from another site, which could otherwise ride on the session cookie', async () => {
        expect(await handshakeStatus(port, 'https://attacker.example')).toBe(400)
    })

    it('refuses a handshake without an origin, which every browser sends', async () => {
        expect(await handshakeStatus(port)).toBe(400)
    })
})
