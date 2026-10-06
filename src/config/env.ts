import { ConfigModule } from '@nestjs/config'
import { z } from 'zod'
import { logFormatSchema } from './log-format'
import { readSecretsFile } from './secrets-file'

const flagSchema = z
    .enum(['0', '1', 'true', 'false'])
    .default('0')
    .transform((value) => value === '1' || value === 'true')

// Every setting either process reads, validated once at startup. The API and the worker share one schema;
// process-specific secrets (BETTER_AUTH_SECRET) are asserted by the module that needs them.
const envSchema = z.object({
    PORT: z.coerce.number().int().positive().default(8080),
    LOG_FORMAT: logFormatSchema,
    // Path to a bundle of secrets mounted as JSON (Secret Manager's API_SECRETS in production); unset locally.
    SECRETS_FILE: z.string().optional(),
    MONGODB_URI: z.string().min(1),
    GOOGLE_CLOUD_PROJECT: z.string().min(1),
    GCP_REGION: z.string().default('europe-west1'),
    STORAGE_BUCKET: z.string().min(1),
    STORAGE_KEY_FILE: z.string().optional(),
    WEB_ORIGIN: z.url().default('http://localhost:3000'),
    BETTER_AUTH_URL: z.url().default('http://localhost:8080'),
    BETTER_AUTH_SECRET: z.string().optional(),
    // Parent domain the session cookie is shared across (api. and www.); unset locally, where cookies stay host-only.
    COOKIE_DOMAIN: z.string().optional(),
    // Required by the API, which asserts it in MailModule; the worker sends no email.
    RESEND_API_KEY: z.string().optional(),
    MAIL_FROM: z.string().default('AdLens <no-reply@mail.useadlens.com>'),
    // Where Contact form messages go. Unset, the form answers 503.
    CONTACT_EMAIL: z.email().optional(),
    // Sign-in with Google / GitHub; a provider is enabled when both of its values are set.
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    // No default: the committed .env, which ships in the image, is the one place it is set.
    QUOTA_LIMIT: z.coerce.number().int().positive(),
    // Weekly caps per network (an IPv4 address or an IPv6 /64): analyses by anonymous users and unconfirmed accounts;
    // analyses by anyone before a Turnstile check is required; analyses by anyone at all.
    IP_ANON_LIMIT: z.coerce.number().int().positive().default(3),
    IP_SOFT_LIMIT: z.coerce.number().int().positive().default(10),
    IP_HARD_LIMIT: z.coerce.number().int().positive().default(30),
    // Cloudflare Turnstile. Unset, a required check can never pass.
    TURNSTILE_SECRET_KEY: z.string().optional(),
    // Proxies in front of the API that append to X-Forwarded-For: 1 on Cloud Run (Google's front end).
    TRUSTED_PROXY_HOPS: z.coerce.number().int().positive().default(1),
    GEMINI_MODEL: z.string().default('gemini-3.8-flash'),
    GEMINI_LOCATION: z.string().default('global'),
    ANALYZE_LOCAL: flagSchema,
    ANALYZE_JOB_NAME: z.string().default('adlens-analyze'),
    // Must equal the Cloud Run Job's --max-retries, so the worker knows which attempt is its last.
    ANALYZE_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
    CLOUD_RUN_TASK_ATTEMPT: z.coerce.number().int().nonnegative().default(0),
    WORKER_JOB_ID: z.string().optional(),
})

export type Env = z.infer<typeof envSchema>

export const validateEnv = (raw: Record<string, unknown>): Env => {
    const result = envSchema.safeParse(raw)

    if (!result.success) {
        throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`)
    }

    return result.data
}

// SECRETS_FILE's keys fill gaps in the raw config; anything already in the environment or .env* wins, so local
// overrides and tests are unaffected by what a mounted bundle holds.
export const validateEnvWithSecretsFile = (raw: Record<string, unknown>): Env => {
    const secretsPath = typeof raw.SECRETS_FILE === 'string' ? raw.SECRETS_FILE : undefined

    return validateEnv({ ...readSecretsFile(secretsPath), ...raw })
}

// Tests never read .env files: they must not pick up a developer's secrets or real database.
export const appConfigModule = ConfigModule.forRoot({
    isGlobal: true,
    envFilePath: ['.env.local', '.env'],
    ignoreEnvFile: process.env.NODE_ENV === 'test',
    validate: validateEnvWithSecretsFile,
})
