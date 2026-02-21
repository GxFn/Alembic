export default {
  testEnvironment: 'node',
  testTimeout: 30000,
  transform: {},
  collectCoverageFrom: ['lib/**/*.js', '!lib/**/index.js', '!lib/bootstrap.js'],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: {
      branches: 75,
      functions: 75,
      lines: 80,
      statements: 80,
    },
  },
  testMatch: ['**/test/**/*.test.js'],
  testPathIgnorePatterns: [
    '/node_modules/',
    // 排除使用 node:test 的文件（需通过 Node 原生测试运行器执行）
    'test/integration/http-server\\.test\\.js',
    'test/integration/api-endpoints\\.test\\.js',
  ],
};
