module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  // Those need the Firestore emulator: `npm run test:emulator`.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/emulator/'],
};
