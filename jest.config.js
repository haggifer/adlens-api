module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    rootDir: 'src',
    testRegex: '.*\\.spec\\.ts$',
    moduleFileExtensions: ['ts', 'js', 'json'],
    testTimeout: 60000,
    setupFiles: ['<rootDir>/../test/test-env.ts'],
}
