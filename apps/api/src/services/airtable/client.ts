import { env, integrations } from '../../config/env.js';
import { IntegrationError } from '../../lib/errors.js';
import { fetchWithTimeout, readJsonResponse } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { maybeInjectFailure, mockLatency } from '../mockControl.js';

/**
 * Minimal Airtable REST client.
 *
 * Only the three operations the automation actually needs: find by field,
 * create, update. No SDK - the SDK adds a dependency, its own retry semantics
 * and its own error taxonomy, none of which compose with our outbox.
 *
 * In mock mode records live in memory so the full n8n -> Airtable path,
 * including the idempotency lookup, is exercised locally.
 */

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
  createdTime: string;
}

const mockTables = new Map<string, AirtableRecord[]>();

function mockTable(table: string): AirtableRecord[] {
  if (!mockTables.has(table)) mockTables.set(table, []);
  return mockTables.get(table)!;
}

export function resetMockAirtable(): void {
  mockTables.clear();
}

export function getMockAirtableSnapshot(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [table, records] of mockTables) out[table] = records.length;
  return out;
}

function baseUrl(table: string): string {
  return `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`;
}

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${env.AIRTABLE_TOKEN}`,
    'content-type': 'application/json',
  };
}

/** Escape a value for use inside an Airtable formula string literal. */
function escapeFormulaValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Look up a single record by an exact field match.
 *
 * This is the idempotency probe: before writing a lead we ask Airtable whether
 * that lead_id already exists. Airtable has no unique constraints, so the check
 * has to be explicit.
 */
export async function findRecordByField(
  table: string,
  field: string,
  value: string,
): Promise<AirtableRecord | null> {
  if (integrations.airtable.mock) {
    maybeInjectFailure('airtable');
    await mockLatency(20, 60);
    return mockTable(table).find((record) => record.fields[field] === value) ?? null;
  }

  const formula = `{${field}} = '${escapeFormulaValue(value)}'`;
  const url = `${baseUrl(table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;

  const response = await fetchWithTimeout(url, { method: 'GET', headers: authHeaders() }, 8000, 'airtable');
  const parsed = await readJsonResponse<{ records?: AirtableRecord[] }>(response, 'airtable');
  return parsed.records?.[0] ?? null;
}

export async function createRecord(
  table: string,
  fields: Record<string, unknown>,
): Promise<AirtableRecord> {
  if (integrations.airtable.mock) {
    maybeInjectFailure('airtable');
    await mockLatency();
    const record: AirtableRecord = {
      id: `rec${Math.random().toString(36).slice(2, 16)}`,
      fields,
      createdTime: new Date().toISOString(),
    };
    mockTable(table).push(record);
    logger.info('airtable.mock_create', { table, record_id: record.id, fields: Object.keys(fields) });
    return record;
  }

  const response = await fetchWithTimeout(
    baseUrl(table),
    {
      method: 'POST',
      headers: authHeaders(),
      // typecast lets Airtable coerce strings into single-selects it already
      // knows, which keeps the funnel from breaking when a new option appears.
      body: JSON.stringify({ fields, typecast: true }),
    },
    8000,
    'airtable',
  );

  const parsed = await readJsonResponse<AirtableRecord & { error?: unknown }>(response, 'airtable');
  if (!parsed.id) {
    throw new IntegrationError('airtable', 'Airtable returned no record id', { retryable: false });
  }
  return parsed;
}

export async function updateRecord(
  table: string,
  recordId: string,
  fields: Record<string, unknown>,
): Promise<AirtableRecord> {
  if (integrations.airtable.mock) {
    maybeInjectFailure('airtable');
    await mockLatency();
    const record = mockTable(table).find((item) => item.id === recordId);
    if (!record) {
      throw new IntegrationError('airtable', `Mock record ${recordId} not found`, {
        retryable: false,
      });
    }
    record.fields = { ...record.fields, ...fields };
    return record;
  }

  const response = await fetchWithTimeout(
    `${baseUrl(table)}/${recordId}`,
    {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ fields, typecast: true }),
    },
    8000,
    'airtable',
  );

  return readJsonResponse<AirtableRecord>(response, 'airtable');
}

/** Batch create, capped at Airtable's documented limit of 10 records. */
export async function createRecords(
  table: string,
  rows: Record<string, unknown>[],
): Promise<AirtableRecord[]> {
  const created: AirtableRecord[] = [];
  for (let i = 0; i < rows.length; i += 10) {
    const chunk = rows.slice(i, i + 10);
    if (integrations.airtable.mock) {
      for (const fields of chunk) created.push(await createRecord(table, fields));
      continue;
    }

    const response = await fetchWithTimeout(
      baseUrl(table),
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ records: chunk.map((fields) => ({ fields })), typecast: true }),
      },
      10_000,
      'airtable',
    );
    const parsed = await readJsonResponse<{ records: AirtableRecord[] }>(response, 'airtable');
    created.push(...parsed.records);
  }
  return created;
}

export const AIRTABLE_TABLES = {
  leads: () => env.AIRTABLE_LEADS_TABLE,
  qualification: () => env.AIRTABLE_QUALIFICATION_TABLE,
  events: () => env.AIRTABLE_EVENTS_TABLE,
  automationRuns: () => env.AIRTABLE_AUTOMATION_RUNS_TABLE,
} as const;
