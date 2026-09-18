import { defineConfig } from 'vitest/config';
import path from 'node:path';

const here = import.meta.dirname;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/api/**/*.test.ts', 'apps/web/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    reporters: 'default',
    globals: false,
    /**
     * Tests run fully hermetically: in-memory store, every integration mocked,
     * no network. Failure injection is switched on per-test rather than
     * globally, so the reliability paths are exercised deliberately.
     *
     * These are set here rather than in a .env.test so that a developer's local
     * .env can never change what CI asserts.
     */
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      DATA_DIR: './.tmp-test-data',
      FUNNEL_VERSION: 'qualification-v1',
      MOCK_MODE: 'true',
      MOCK_META: 'true',
      MOCK_N8N: 'true',
      MOCK_AIRTABLE: 'true',
      MOCK_AIRTABLE_FAILURE: 'false',
      MOCK_N8N_FAILURE: 'false',
      MOCK_META_FAILURE: 'false',
      MOCK_FAILURE_RATE: '0',
      // The worker is driven explicitly in tests so timing is deterministic.
      OUTBOX_ENABLED: 'false',
      OUTBOX_MAX_ATTEMPTS: '3',
      OUTBOX_BASE_BACKOFF_MS: '10',
      OUTBOX_MAX_BACKOFF_MS: '50',
      RATE_LIMIT_MAX_LEADS: '10',
      RATE_LIMIT_MAX_EVENTS: '120',
      RATE_LIMIT_WINDOW_MS: '60000',
      ADMIN_API_TOKEN: 'test-admin-token',
      N8N_WEBHOOK_SECRET: 'test-secret',
      N8N_WEBHOOK_URL: 'http://n8n.test.invalid/webhook/lead-to-airtable',
      CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    },
  },
  resolve: {
    alias: {
      '@funnel/shared': path.resolve(here, 'packages/shared/src/index.ts'),
    },
  },
});
