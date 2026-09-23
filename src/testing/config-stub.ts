import type { ConfigService } from '@nestjs/config'
import type { Env } from '../config/env'

export const configStub = (values: Partial<Env>): ConfigService<Env, true> =>
    ({ get: (key: keyof Env) => values[key] }) as unknown as ConfigService<Env, true>
