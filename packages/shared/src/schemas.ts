import { z } from 'zod';
import { FUNNEL_EVENTS } from './events.js';
import { isValidEmail, isValidPhone, normalisePhone } from './funnel/engine.js';

/**
 * Wire contracts shared by the browser and the API.
 *
 * The browser uses them for fast local feedback; the API treats them as the
 * source of truth and re-validates everything. Nothing the client sends is
 * trusted - ids, timestamps and qualification outcomes are all recomputed
 * server-side.
 */

const trimmed = (max: number) => z.string().trim().max(max);

/** Matches ASCII control characters. Built via RegExp so the source file itself
 *  stays free of literal control bytes. */
const CONTROL_CHARS = new RegExp('[\\x00-\\x1F\\x7F]', 'g');

/**
 * Strips angle brackets and control characters.
 *
 * Defence in depth: we always render through React (which escapes), but this
 * same data lands in Airtable, in transactional email and in Slack alerts,
 * where escaping is not automatic.
 */
const clean = (value: string): string =>
  value.replace(CONTROL_CHARS, '').replace(/[<>]/g, '').trim();

export const sanitisedString = (max: number) => trimmed(max).transform(clean);

/**
 * Required variant. `.min()` has to run on the raw string - Zod's transform
 * returns a ZodEffects, which has no string methods - and the trailing refine
 * re-checks emptiness in case sanitisation stripped the value to nothing.
 */
export const requiredSanitisedString = (max: number, message: string) =>
  z
    .string()
    .trim()
    .min(1, message)
    .max(max)
    .transform(clean)
    .refine((value) => value.length > 0, message);

export const attributionSchema = z.object({
  utm_source: sanitisedString(120).optional(),
  utm_medium: sanitisedString(120).optional(),
  utm_campaign: sanitisedString(200).optional(),
  utm_content: sanitisedString(200).optional(),
  utm_term: sanitisedString(200).optional(),
  fbclid: sanitisedString(500).optional(),
  gclid: sanitisedString(500).optional(),
  /** Meta browser cookies. Required for good CAPI match quality. */
  fbp: sanitisedString(200).optional(),
  fbc: sanitisedString(500).optional(),
  landing_page: trimmed(1000).optional(),
  referrer: trimmed(1000).optional(),
  funnel_version: sanitisedString(60),
  /** Client clock - stored for diagnostics only, never used for ordering. */
  client_timestamp: z.string().optional(),
});

export type Attribution = z.infer<typeof attributionSchema>;

export const answerValueSchema = z.union([
  sanitisedString(500),
  z.array(sanitisedString(200)).max(25),
]);

export const answersSchema = z.record(sanitisedString(80), answerValueSchema);

export const contactSchema = z.object({
  first_name: requiredSanitisedString(80, 'First name is required'),
  last_name: requiredSanitisedString(80, 'Last name is required'),
  email: trimmed(320)
    .min(1, 'Email is required')
    .refine(isValidEmail, 'Enter a valid email address')
    .transform((value) => value.toLowerCase()),
  phone: trimmed(40)
    .min(1, 'Phone number is required')
    .refine(isValidPhone, 'Enter a valid 10-digit phone number')
    .transform(normalisePhone),
});

export type ContactInput = z.infer<typeof contactSchema>;

/**
 * Client-supplied hints for Meta matching and deduplication.
 *
 * `event_id` is generated in the browser so that the Pixel copy and the CAPI
 * copy of the same conversion can share it. The server validates its shape but
 * never trusts it for anything security-sensitive.
 */
export const clientContextSchema = z.object({
  session_id: sanitisedString(60),
  /** Shared dedup key for the Lead conversion. */
  event_id: sanitisedString(60).optional(),
  /** True when the browser Pixel successfully fired its copy of the event. */
  pixel_fired: z.boolean().optional().default(false),
  user_agent: trimmed(600).optional(),
});

export const leadSubmissionSchema = z.object({
  contact: contactSchema,
  answers: answersSchema,
  attribution: attributionSchema,
  client: clientContextSchema,
  /**
   * Set when the browser retries a submission it is not sure succeeded.
   * Combined with `client.event_id` this makes POST /api/leads idempotent.
   */
  idempotency_key: sanitisedString(80).optional(),
});

export type LeadSubmission = z.infer<typeof leadSubmissionSchema>;

/** Partial capture, fired as soon as the email step is completed. */
export const emailCaptureSchema = z.object({
  email: trimmed(320)
    .min(1)
    .refine(isValidEmail, 'Enter a valid email address')
    .transform((value) => value.toLowerCase()),
  answers: answersSchema.optional().default({}),
  attribution: attributionSchema,
  client: clientContextSchema,
});

export type EmailCaptureInput = z.infer<typeof emailCaptureSchema>;

const eventNameSchema = z.enum([
  FUNNEL_EVENTS.PageView,
  FUNNEL_EVENTS.ViewContent,
  FUNNEL_EVENTS.FunnelStarted,
  FUNNEL_EVENTS.QuestionCompleted,
  FUNNEL_EVENTS.QualificationStarted,
  FUNNEL_EVENTS.QualificationCompleted,
  FUNNEL_EVENTS.EmailCaptured,
  FUNNEL_EVENTS.Lead,
]);

/**
 * Telemetry beacon.
 *
 * Deliberately narrow: `step_number` and `question_id` are accepted (an id is
 * not an answer) but no answer value may ever be sent through this endpoint.
 */
export const trackEventSchema = z.object({
  event_name: eventNameSchema,
  event_id: sanitisedString(60),
  session_id: sanitisedString(60),
  lead_id: sanitisedString(60).optional(),
  question_id: sanitisedString(80).optional(),
  step_number: z.number().int().min(0).max(100).optional(),
  attribution: attributionSchema.partial().optional(),
  /** Whether the browser Pixel already sent its copy of this event. */
  pixel_fired: z.boolean().optional().default(false),
});

export type TrackEventInput = z.infer<typeof trackEventSchema>;

export type LeadStatus = 'new' | 'qualified' | 'review' | 'disqualified' | 'duplicate';

export type AutomationStatus =
  | 'pending'
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'dead_letter'
  | 'skipped';
