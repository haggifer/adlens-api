import { createParamDecorator, ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'
import type { IpSource } from '../ip-quota/client-ip'

// The raw material for the client's address; ClientNetworkResolver decides which part of it to trust.
export const RequestIpSource = createParamDecorator((_data: unknown, ctx: ExecutionContext): IpSource => {
    const req = ctx.switchToHttp().getRequest<Request>()

    return { forwardedFor: req.headers['x-forwarded-for'], socketAddress: req.socket.remoteAddress }
})
