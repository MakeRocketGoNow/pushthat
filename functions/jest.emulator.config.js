// The suites that run against the Firestore and Storage emulators (test/emulator): `npm run test:emulator`.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  roots: ['<rootDir>/test/emulator'],
  // One database for every suite, so one suite at a time.
  maxWorkers: 1,
  // Transactions that contend wait on the emulator's locks, seconds at a time.
  testTimeout: 30_000,
};
