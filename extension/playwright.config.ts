import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 20_000,
  expect: { timeout: 6_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  outputDir: 'test-results',
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node ../scripts/serve-demo.mjs ../dummy-page 4173',
    url: 'http://127.0.0.1:4173/__secureintent_health',
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
});
