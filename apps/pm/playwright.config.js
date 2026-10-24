import { defineConfig } from '@playwright/test';

// The project assistant checks isConfigured() before it sends anything. The specs
// mock the gateway, so a placeholder key is enough to make the assistant render.
process.env.VITE_FUSION_GATEWAY_KEY ||= 'playwright-test-key';

const port = Number(process.env.PLAYWRIGHT_PORT || 5191);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PLAYWRIGHT_PORT must be a port number from 1 to 65535.');
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30000,
  use: {
    baseURL,
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
  },
});
