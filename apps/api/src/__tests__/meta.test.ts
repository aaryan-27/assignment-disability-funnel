import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { buildFbc, buildServerEvent, buildUserData, isEventTooOld } from '../services/meta/payload.js';
import { hashEmail, hashGender, hashPhone, hashName, safeCompare } from '../lib/hash.js';
import { redact } from '../lib/logger.js';
import { listJobs, resetStore, snapshot } from '../store/repository.js';
import { resetRateLimits } from '../middleware/rateLimit.js';
import { buildSubmission, listenOnce } from './helpers.js';

const app = createApp();
const server = listenOnce(app);

afterAll(() => {
  server.close();
});
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

beforeEach(async () => {
  await resetStore();
  resetRateLimits();
});

describe('Advanced Matching normalisation', () => {
  it('lowercases and trims the email before hashing', () => {
    // Meta's documented rule. Getting it wrong silently halves match quality:
    // the request still returns 200, the attribution just disappears.
    expect(hashEmail('  Dana@Example.COM ')).toBe(sha256('dana@example.com'));
  });

  it('prefixes a bare 10-digit US number with the country code', () => {
    expect(hashPhone('(415) 555-0132')).toBe(sha256('14155550132'));
    expect(hashPhone('4155550132')).toBe(sha256('14155550132'));
    // An already-prefixed number must not be double-prefixed.
    expect(hashPhone('14155550132')).toBe(sha256('14155550132'));
  });

  it('reduces gender to the single character Meta expects', () => {
    expect(hashGender('male')).toBe(sha256('m'));
    expect(hashGender('female')).toBe(sha256('f'));
    // Non-binary and undisclosed have no valid Meta representation, so we send
    // nothing rather than guessing.
    expect(hashGender('non_binary')).toBeUndefined();
    expect(hashGender('undisclosed')).toBeUndefined();
  });

  it('lowercases names', () => {
    expect(hashName('Whitfield')).toBe(sha256('whitfield'));
  });

  it('returns undefined for empty input rather than hashing an empty string', () => {
    // Hashing '' produces a valid-looking hash that matches nobody and drags
    // the reported match quality down.
    expect(hashEmail(undefined)).toBeUndefined();
    expect(hashEmail('')).toBeUndefined();
    expect(hashPhone('')).toBeUndefined();
    expect(hashName('   ')).toBeUndefined();
  });
});

describe('buildUserData', () => {
  it('omits keys with no value', () => {
    const userData = buildUserData({
      eventName: 'Lead',
      eventId: 'evt_1',
      email: 'dana@example.com',
    });

    expect(userData.em).toEqual([sha256('dana@example.com')]);
    expect(userData).not.toHaveProperty('ph');
    expect(userData).not.toHaveProperty('fn');
    expect(userData).not.toHaveProperty('fbc');
  });

  it('never emits a raw identifier', () => {
    const userData = buildUserData({
      eventName: 'Lead',
      eventId: 'evt_1',
      email: 'dana@example.com',
      phone: '4155550132',
      firstName: 'Dana',
      lastName: 'Whitfield',
    });

    const serialised = JSON.stringify(userData);
    expect(serialised).not.toContain('dana@example.com');
    expect(serialised).not.toContain('4155550132');
    expect(serialised).not.toContain('Dana');
    expect(serialised).not.toContain('Whitfield');
    // Everything present is a 64-char hex digest.
    for (const key of ['em', 'ph', 'fn', 'ln'] as const) {
      expect(userData[key]?.[0]).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('passes fbp and the client IP through unhashed, as Meta requires', () => {
    const userData = buildUserData({
      eventName: 'Lead',
      eventId: 'evt_1',
      fbp: 'fb.1.1700000000.1234567890',
      clientIp: '203.0.113.9',
      userAgent: 'Mozilla/5.0',
    });

    expect(userData.fbp).toBe('fb.1.1700000000.1234567890');
    expect(userData.client_ip_address).toBe('203.0.113.9');
    expect(userData.client_user_agent).toBe('Mozilla/5.0');
  });
});

describe('fbc reconstruction', () => {
  it('synthesises fbc from a raw fbclid', () => {
    // Recovers attribution when the Pixel never got to write the cookie.
    expect(buildFbc('IwAR0Test', 1_700_000_000_000)).toBe('fb.1.1700000000000.IwAR0Test');
  });

  it('returns undefined without an fbclid', () => {
    expect(buildFbc(undefined)).toBeUndefined();
  });

  it('prefers a real fbc cookie over a synthesised one', () => {
    const userData = buildUserData({
      eventName: 'Lead',
      eventId: 'evt_1',
      fbc: 'fb.1.1699999999999.RealCookie',
      fbclid: 'SynthesisedClickId',
    });
    expect(userData.fbc).toBe('fb.1.1699999999999.RealCookie');
  });
});

describe('buildServerEvent', () => {
  it('builds a well-formed CAPI event', () => {
    const event = buildServerEvent({
      eventName: 'Lead',
      eventId: 'evt_shared_123',
      eventTime: new Date('2026-01-01T00:00:00.000Z'),
      email: 'dana@example.com',
      qualificationOutcome: 'qualified',
      value: 120,
      sourceUrl: 'https://funnel.example.com/q',
    });

    expect(event).not.toBeNull();
    expect(event!.event_name).toBe('Lead');
    // The shared dedup key is preserved verbatim.
    expect(event!.event_id).toBe('evt_shared_123');
    expect(event!.action_source).toBe('website');
    // event_time is in seconds, not milliseconds.
    expect(event!.event_time).toBe(1767225600);
    expect(event!.custom_data?.value).toBe(120);
    expect(event!.custom_data?.currency).toBe('USD');
    expect(event!.custom_data?.lead_quality).toBe('priority');
  });

  it('returns null for internal-only events', () => {
    // QuestionCompleted has no Meta mapping, so nothing is ever built for it.
    expect(buildServerEvent({ eventName: 'QuestionCompleted', eventId: 'evt_x' })).toBeNull();
  });

  it('strips any sensitive parameter that reaches it', () => {
    const event = buildServerEvent({
      eventName: 'Lead',
      eventId: 'evt_1',
      qualificationOutcome: 'qualified',
      // Simulate a future caller passing something it should not.
      ...({ receiving_benefits: 'ssi', under_medical_care: 'yes' } as Record<string, string>),
    });

    const serialised = JSON.stringify(event!.custom_data);
    expect(serialised).not.toContain('ssi');
    expect(serialised).not.toContain('under_medical_care');
  });

  it('sends a coarse quality bucket, never the numeric score or reasons', () => {
    const event = buildServerEvent({
      eventName: 'Lead',
      eventId: 'evt_1',
      qualificationOutcome: 'review',
    });

    expect(event!.custom_data?.lead_quality).toBe('standard');
    expect(event!.custom_data?.qualification_score).toBeUndefined();
    expect(event!.custom_data?.qualification_reasons).toBeUndefined();
  });

  it('rejects events outside Meta 7-day window', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    expect(isEventTooOld(eightDaysAgo)).toBe(true);
    expect(isEventTooOld(new Date())).toBe(false);
  });
});

describe('event deduplication', () => {
  it('reuses the browser event_id for the server-side Lead conversion', async () => {
    const submission = buildSubmission();
    const browserEventId = submission.client.event_id!;

    const response = await request(server).post('/api/leads').send(submission).expect(201);

    // Same id on both sides is the entire deduplication mechanism.
    expect(response.body.event_id).toBe(browserEventId);

    const jobs = await listJobs(10);
    const metaJob = jobs.find((job) => job.type === 'meta_capi');
    expect(metaJob?.event_id).toBe(browserEventId);
    expect(metaJob?.dedupe_key).toBe(`meta:${browserEventId}`);
  });

  it('records that the browser pixel already fired', async () => {
    const submission = buildSubmission();
    submission.client.pixel_fired = true;

    await request(server).post('/api/leads').send(submission).expect(201);

    const event = await snapshot((db) =>
      db.events.find((item) => item.event_id === submission.client.event_id),
    );
    expect(event?.pixel_fired).toBe(true);
  });

  it('counts a repeated event_id as a prevented duplicate', async () => {
    const body = {
      event_name: 'FunnelStarted',
      event_id: 'evt_dedupbeacon0001',
      session_id: 'ses_test0000000001',
      step_number: 1,
    };

    const first = await request(server).post('/api/events').send(body).expect(202);
    const second = await request(server).post('/api/events').send(body).expect(200);

    expect(first.body.duplicate).toBe(false);
    expect(second.body.duplicate).toBe(true);

    const counter = await snapshot((db) => db.counters.duplicate_events_prevented);
    expect(counter).toBe(1);
  });
});

describe('POST /api/events privacy boundary', () => {
  it('accepts a question id and step number', async () => {
    await request(server)
      .post('/api/events')
      .send({
        event_name: 'QuestionCompleted',
        event_id: 'evt_questioncomplete1',
        session_id: 'ses_test0000000002',
        question_id: 'under_medical_care',
        step_number: 7,
      })
      .expect(202);
  });

  it('ignores any answer value smuggled into the beacon', async () => {
    await request(server)
      .post('/api/events')
      .send({
        event_name: 'QuestionCompleted',
        event_id: 'evt_smuggle000000001',
        session_id: 'ses_test0000000003',
        question_id: 'under_medical_care',
        answer: 'yes',
        diagnosis: 'severe back injury',
      })
      .expect(202);

    // The schema strips unknown keys; nothing sensitive is persisted.
    const stored = await snapshot((db) =>
      db.events.find((item) => item.event_id === 'evt_smuggle000000001'),
    );
    const serialised = JSON.stringify(stored);
    expect(serialised).not.toContain('severe back injury');
    expect(serialised).not.toContain('diagnosis');
  });

  it('never creates a Meta job for an internal-only event', async () => {
    await request(server)
      .post('/api/events')
      .send({
        event_name: 'QuestionCompleted',
        event_id: 'evt_internalonly00001',
        session_id: 'ses_test0000000004',
        step_number: 3,
      })
      .expect(202);

    const jobs = await listJobs(10);
    expect(jobs.filter((job) => job.type === 'meta_capi')).toHaveLength(0);
  });

  it('rejects an unknown event name', async () => {
    await request(server)
      .post('/api/events')
      .send({
        event_name: 'ExfiltrateEverything',
        event_id: 'evt_bad0000000000001',
        session_id: 'ses_test0000000005',
      })
      .expect(400);
  });
});

describe('log redaction', () => {
  it('redacts identifiers and drops answers entirely', () => {
    const redacted = redact({
      lead_id: 'ld_keepme',
      email: 'dana@example.com',
      phone: '4155550132',
      first_name: 'Dana',
      fbc: 'fb.1.123.abc',
      answers: { under_medical_care: 'yes', receiving_benefits: 'ssi' },
    }) as Record<string, unknown>;

    // Non-sensitive correlation ids survive - that is the point of logging.
    expect(redacted.lead_id).toBe('ld_keepme');

    const serialised = JSON.stringify(redacted);
    expect(serialised).not.toContain('dana@example.com');
    expect(serialised).not.toContain('4155550132');
    expect(serialised).not.toContain('Dana');
    // Health answers never reach the log stream in any form.
    expect(serialised).not.toContain('under_medical_care');
    expect(serialised).not.toContain('ssi');
  });

  it('redacts nested structures', () => {
    const redacted = redact({ contact: { email: 'x@y.com', first_name: 'Dana' } });
    expect(JSON.stringify(redacted)).not.toContain('x@y.com');
  });
});

describe('safeCompare', () => {
  it('matches identical strings and rejects others', () => {
    expect(safeCompare('token123', 'token123')).toBe(true);
    expect(safeCompare('token123', 'token124')).toBe(false);
    // Different lengths must not throw.
    expect(safeCompare('short', 'muchlongertoken')).toBe(false);
  });
});
