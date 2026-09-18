import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));

// The .env lives at the repo root so a single file configures both tiers.
// Tests get their environment from vitest.config.mts instead, so a developer's
// local .env can never change what CI asserts.
if (process.env.NODE_ENV !== 'test') {
  loadDotenv({ path: path.resolve(here, '../../../../.env'), quiet: true });
}

/** Accepts "true"/"1"/"yes" in any casing. Everything else is false. */
const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return fallback;
      return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
    });

const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return fallback;
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    });

const float = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return fallback;
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    });

const str = (fallback = '') =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? fallback : value.trim()));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(4000),
  APP_URL: str('http://localhost:5173'),
  CORS_ALLOWED_ORIGINS: str('http://localhost:5173'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  FUNNEL_VERSION: str('qualification-v1'),
  DATA_DIR: str('./data'),
  /**
   * Postgres connection string. When set, the store lives in Postgres instead
   * of a JSON file - required on serverless hosts, whose filesystem is
   * read-only and not shared between instances. Vercel's Neon integration
   * injects POSTGRES_URL, so that is accepted as a fallback.
   */
  DATABASE_URL: str(),
  POSTGRES_URL: str(),
  /** Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` to the drain route. */
  CRON_SECRET: str(),

  META_PIXEL_ID: str(),
  META_ACCESS_TOKEN: str(),
  META_TEST_EVENT_CODE: str(),
  META_API_VERSION: str('v20.0'),
  META_CAPI_ENABLED: bool(true),

  N8N_WEBHOOK_URL: str(),
  N8N_WEBHOOK_SECRET: str('local-dev-secret'),
  N8N_TIMEOUT_MS: int(20000),

  AIRTABLE_TOKEN: str(),
  AIRTABLE_BASE_ID: str(),
  AIRTABLE_LEADS_TABLE: str('Leads'),
  AIRTABLE_QUALIFICATION_TABLE: str('Qualification'),
  AIRTABLE_EVENTS_TABLE: str('Events'),
  AIRTABLE_AUTOMATION_RUNS_TABLE: str('Automation Runs'),

  MOCK_MODE: bool(true),
  MOCK_META: bool(true),
  MOCK_N8N: bool(false),
  MOCK_AIRTABLE: bool(true),
  MOCK_AIRTABLE_FAILURE: bool(false),
  MOCK_N8N_FAILURE: bool(false),
  MOCK_META_FAILURE: bool(false),
  MOCK_FAILURE_RATE: float(0),

  OUTBOX_ENABLED: bool(true),
  OUTBOX_POLL_INTERVAL_MS: int(2000),
  OUTBOX_MAX_ATTEMPTS: int(5),
  OUTBOX_BASE_BACKOFF_MS: int(1000),
  OUTBOX_MAX_BACKOFF_MS: int(300_000),

  RATE_LIMIT_WINDOW_MS: int(60_000),
  RATE_LIMIT_MAX_LEADS: int(10),
  RATE_LIMIT_MAX_EVENTS: int(600),
  ADMIN_API_TOKEN: str('local-admin-token'),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast and loudly: a misconfigured tracking service is worse than a
  // service that refuses to start.
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}

export const env: Env = parsed.data;

export const corsOrigins: string[] = env.CORS_ALLOWED_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
/** Set by Vercel on every build and function invocation. */
export const isVercel = Boolean(process.env.VERCEL);

export const databaseUrl = env.DATABASE_URL || env.POSTGRES_URL;

const DEFAULT_ADMIN_TOKEN = 'local-admin-token';

/** True when the admin token is unset or still a local placeholder. */
export function isAdminTokenInsecure(): boolean {
  return !env.ADMIN_API_TOKEN || env.ADMIN_API_TOKEN === DEFAULT_ADMIN_TOKEN || env.ADMIN_API_TOKEN.length < 24;
}

/**
 * Settings that are fine on a laptop but wrong for real traffic. Logged at
 * startup rather than thrown, so a preview deploy still boots - but never
 * exposed on a public endpoint, because they describe the attack surface.
 */
export function productionConfigWarnings(): string[] {
  if (!isProduction && !isVercel) return [];
  const warnings: string[] = [];

  if (env.META_TEST_EVENT_CODE) {
    warnings.push('META_TEST_EVENT_CODE is set: every conversion goes to Test Events and is invisible to ad optimisation. Remove it once testing is done.');
  }
  if (isAdminTokenInsecure()) {
    warnings.push('ADMIN_API_TOKEN is missing, a placeholder, or shorter than 24 characters: /admin is disabled until it is set.');
  }
  if (isVercel && !databaseUrl) {
    warnings.push('No DATABASE_URL on Vercel: leads and the retry queue live in ephemeral /tmp and will be lost. Attach a Postgres database.');
  }
  if (isVercel && !env.CRON_SECRET) {
    warnings.push('CRON_SECRET is not set: the scheduled outbox drain is rejected, so failed jobs only retry when new traffic arrives.');
  }
  const mocked = Object.entries(integrations)
    .filter(([, value]) => value.mock)
    .map(([name]) => name);
  if (mocked.length > 0) {
    warnings.push(`Mocked integrations in production: ${mocked.join(', ')}. Set MOCK_MODE/MOCK_META/MOCK_AIRTABLE=false and provide credentials.`);
  }
  return warnings;
}

/**
 * Integration switches, resolved once.
 *
 * MOCK_MODE is a master switch: it turns on mocking for anything that has not
 * been explicitly configured with real credentials. This is what makes the
 * project runnable with an empty .env while still using real services the
 * moment credentials appear.
 */
export const integrations = {
  meta: {
    /** Real CAPI calls require a token; otherwise we always mock. */
    mock: env.MOCK_META || env.MOCK_MODE || !env.META_ACCESS_TOKEN || !env.META_PIXEL_ID,
    enabled: env.META_CAPI_ENABLED,
  },
  n8n: {
    mock: env.MOCK_N8N || !env.N8N_WEBHOOK_URL,
  },
  airtable: {
    mock: env.MOCK_AIRTABLE || env.MOCK_MODE || !env.AIRTABLE_TOKEN || !env.AIRTABLE_BASE_ID,
  },
} as const;

/** Log each production warning once. Called from every entry point. */
export function logConfigWarnings(log: (msg: string, meta: Record<string, unknown>) => void): void {
  for (const warning of productionConfigWarnings()) log('config.production_warning', { warning });
}

/** Startup banner data - logged once so the operator knows what is live. */
export function describeIntegrations(): Record<string, string> {
  return {
    meta_capi: !integrations.meta.enabled
      ? 'disabled'
      : integrations.meta.mock
        ? 'mock'
        : 'live',
    n8n: integrations.n8n.mock ? 'mock' : `live:${env.N8N_WEBHOOK_URL}`,
    airtable: integrations.airtable.mock ? 'mock' : `live:${env.AIRTABLE_BASE_ID}`,
    store: databaseUrl && !isTest ? 'postgres' : 'json-file',
    failure_injection: [
      env.MOCK_AIRTABLE_FAILURE ? 'airtable' : null,
      env.MOCK_N8N_FAILURE ? 'n8n' : null,
      env.MOCK_META_FAILURE ? 'meta' : null,
      env.MOCK_FAILURE_RATE > 0 ? `rate=${env.MOCK_FAILURE_RATE}` : null,
    ]
      .filter(Boolean)
      .join(',') || 'none',
  };
}
