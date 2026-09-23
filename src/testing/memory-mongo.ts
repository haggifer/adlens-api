import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { type Connection } from 'mongoose'

export interface MemoryMongo {
    uri: string
    connection: Connection
    stop: () => Promise<void>
}

// A throwaway MongoDB for tests that depend on real query semantics (atomic guards, pipeline updates).
export const startMemoryMongo = async (): Promise<MemoryMongo> => {
    const server = await MongoMemoryServer.create()
    const uri = server.getUri()
    const connection = await mongoose.createConnection(uri).asPromise()

    return {
        uri,
        connection,
        stop: async () => {
            await connection.close()
            await server.stop()
        },
    }
}
