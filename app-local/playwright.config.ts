import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/playwright',
  testMatch: '**/*.test.ts',
  timeout: 120_000,
  workers: 1,
  reporter: 'list',
  // 稳定性测试失败时要能看出是哪一步跳的：保留录像与 trace，草稿在 test-results/（不入库）。
  use: { trace: 'retain-on-failure', video: 'retain-on-failure' },
});
