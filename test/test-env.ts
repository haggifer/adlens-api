// Jest sets NODE_ENV to test only when it is unset. From a shell with NODE_ENV=development the config module would load
// .env.local, which points at a real database and bucket.
process.env.NODE_ENV = 'test'
