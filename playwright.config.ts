import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.ACT_URL ?? 'https://main.agent-control-tower-56p.pages.dev',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, grepInvert: /@push/ },
    { name: 'phone', use: { ...devices['Pixel 7'] }, grep: /@phone/ },
    // Phone alerts (task 2.6) need Google Chrome: open-source Chromium cannot subscribe to Google's push service.
    { name: 'push', use: { ...devices['Desktop Chrome'], channel: 'chrome' }, grep: /@push/ },
  ],
})
