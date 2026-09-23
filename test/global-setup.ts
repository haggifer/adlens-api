import { MongoMemoryServer } from 'mongodb-memory-server'

declare global {
    var __E2E_MONGO__: MongoMemoryServer | undefined
}

// Starts the e2e database before any test module is imported, so the app's config validation sees it at load time.
export default async function globalSetup(): Promise<void> {
    const mongo = await MongoMemoryServer.create()

    globalThis.__E2E_MONGO__ = mongo
    Object.assign(process.env, {
        NODE_ENV: 'test',
        MONGODB_URI: mongo.getUri(),
        GOOGLE_CLOUD_PROJECT: 'test-project',
        STORAGE_BUCKET: 'test-bucket',
        QUOTA_LIMIT: '3',
    })
}
