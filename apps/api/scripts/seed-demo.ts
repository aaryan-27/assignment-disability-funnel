/**
 * Seeds a realistic dataset so the admin dashboard has something to show
 * before anyone has walked the funnel by hand.
 *
 *   npm run seed:demo
 *
 * It drives the real HTTP API rather than writing to the store directly, so
 * everything it produces has been through validation, qualification, the
 * outbox and the workflow - the numbers on the dashboard are genuine.
 *
 * Run the API first: `npm run dev:api`.
 */
import { funnelConfig, getNextQuestion, newEventId, newSessionId, pruneOrphanedAnswers } from '@funnel/shared';
import type { FunnelAnswers } from '@funnel/shared';

const API = process.env.API_BASE_URL ?? 'http://localhost:4000';

const FIRST_NAMES = ['Dana', 'Marcus', 'Ada', 'Ruth', 'Samuel', 'Gloria', 'Hector', 'Joan', 'Leon', 'Patrice'];
const LAST_NAMES = ['Whitfield', 'Reyes', 'Oyelaran', 'Castellano', 'Boateng', 'Nakamura', 'Fielder', 'Dumont'];

const CAMPAIGNS = [
  { utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'ssdi_prospecting_q3' },
  { utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'ssdi_retargeting_q3' },
  { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'disability_benefits_exact' },
  { utm_source: 'direct', utm_medium: 'none', utm_campaign: '' },
];

/** Answer profiles weighted to produce a believable outcome mix. */
const PROFILES: { weight: number; answers: Record<string, string> }[] = [
  {
    weight: 40,
    answers: {
      age_range: '55_63', receiving_benefits: 'none', work_hours: 'not_working',
      years_employed: 'over_6', asset_value: 'under_2000', out_of_work_year: 'yes',
      under_medical_care: 'yes', application_pending: 'no', gender: 'female',
      marital_status: 'married',
    },
  },
  {
    weight: 25,
    answers: {
      age_range: '50_54', receiving_benefits: 'none', work_hours: 'under_20',
      years_employed: '4_to_6', asset_value: 'over_2000', out_of_work_year: 'yes',
      under_medical_care: 'yes', application_pending: 'yes', attorney_represented: 'yes',
      attorney_firm: 'allsup', application_denied: 'yes', appeal_stage: 'hearing',
      waiting_duration: 'over_9m', gender: 'male', marital_status: 'divorced',
    },
  },
  {
    weight: 20,
    answers: {
      age_range: '40_49', receiving_benefits: 'none', work_hours: 'not_working',
      years_employed: '2_to_4', asset_value: 'not_sure', out_of_work_year: 'yes',
      under_medical_care: 'no', application_pending: 'no', gender: 'male',
      marital_status: 'single',
    },
  },
  {
    weight: 15,
    answers: {
      age_range: 'under_40', receiving_benefits: 'none', work_hours: 'over_20',
      years_employed: 'over_6', asset_value: 'over_2000', out_of_work_year: 'no',
      under_medical_care: 'no', application_pending: 'no', gender: 'undisclosed',
      marital_status: 'single',
    },
  },
];

const pick = <T,>(items: T[]): T => items[Math.floor(Math.random() * items.length)]!;

function pickProfile(): Record<string, string> {
  const total = PROFILES.reduce((sum, p) => sum + p.weight, 0);
  let roll = Math.random() * total;
  for (const profile of PROFILES) {
    roll -= profile.weight;
    if (roll <= 0) return profile.answers;
  }
  return PROFILES[0]!.answers;
}

/**
 * POST with 429 backoff.
 *
 * The lead endpoint is rate limited per IP, and the seeder shares one IP with
 * every simulated visitor. Rather than raising the limit (which would mean the
 * demo no longer exercises the real production configuration), the seeder
 * honours Retry-After the way a well-behaved client should.
 */
async function post(path: string, body: unknown, attempt = 1): Promise<Response> {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (response.status === 429 && attempt <= 3) {
    const retryAfter = Number(response.headers.get('retry-after') ?? '5');
    const waitMs = Math.min(retryAfter * 1000 + 250, 65_000);
    console.log(`  rate limited, waiting ${Math.round(waitMs / 1000)}s ...`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return post(path, body, attempt + 1);
  }

  return response;
}

/** Walks the config exactly as the browser would, respecting branching. */
function collectAnswers(choices: Record<string, string>): { answers: FunnelAnswers; steps: string[] } {
  let answers: FunnelAnswers = {};
  const steps: string[] = [];
  let current = funnelConfig.questions[0]!;

  for (let guard = 0; guard < 40; guard += 1) {
    if (current.type === 'email' || current.type === 'contact') break;
    const value = choices[current.id] ?? current.options?.[0]?.value ?? '';
    answers = pruneOrphanedAnswers(funnelConfig, { ...answers, [current.id]: value });
    steps.push(current.id);

    const next = getNextQuestion(funnelConfig, answers, current.id);
    if (!next) break;
    current = next;
  }

  return { answers, steps };
}

async function simulateVisitor(index: number): Promise<'lead' | 'abandoned'> {
  const sessionId = newSessionId();
  const campaign = pick(CAMPAIGNS);
  const attribution = {
    ...campaign,
    funnel_version: funnelConfig.version,
    landing_page: 'https://funnel.example.com/qualification',
    fbclid: campaign.utm_source === 'facebook' ? `IwAR${Math.random().toString(36).slice(2, 14)}` : undefined,
  };

  await post('/api/events', {
    event_name: 'PageView',
    event_id: newEventId(),
    session_id: sessionId,
    attribution,
  });

  // Question one reaches the screen for everyone who loads the page. The gap
  // between this and FunnelStarted below is the "saw it, never engaged" cohort.
  await post('/api/events', {
    event_name: 'QualificationStarted',
    event_id: newEventId(),
    session_id: sessionId,
    step_number: 1,
    attribution,
  });

  // Realistic drop-off: not every visitor answers the first question.
  if (Math.random() < 0.18) return 'abandoned';

  const { answers, steps } = collectAnswers(pickProfile());

  await post('/api/events', {
    event_name: 'FunnelStarted',
    event_id: newEventId(),
    session_id: sessionId,
    step_number: 1,
    attribution,
  });

  for (const [stepIndex, questionId] of steps.entries()) {
    // Each step loses a few percent of the remaining users.
    if (Math.random() < 0.035) return 'abandoned';
    await post('/api/events', {
      event_name: 'QuestionCompleted',
      event_id: newEventId(),
      session_id: sessionId,
      question_id: questionId,
      step_number: stepIndex + 1,
    });
  }

  await post('/api/events', {
    event_name: 'QualificationCompleted',
    event_id: newEventId(),
    session_id: sessionId,
    attribution,
  });

  const firstName = pick(FIRST_NAMES);
  const lastName = pick(LAST_NAMES);
  const email = `${firstName}.${lastName}.${index}@example.com`.toLowerCase();

  await post('/api/leads/email', {
    email,
    answers,
    attribution,
    client: { session_id: sessionId, event_id: newEventId() },
  });

  // A slice of users abandon between email and phone - the classic drop.
  if (Math.random() < 0.22) return 'abandoned';

  const conversionEventId = newEventId();
  const response = await post('/api/leads', {
    contact: {
      first_name: firstName,
      last_name: lastName,
      email,
      phone: `415555${String(1000 + index).slice(-4)}`,
    },
    answers,
    attribution,
    client: { session_id: sessionId, event_id: conversionEventId, pixel_fired: Math.random() > 0.25 },
    idempotency_key: conversionEventId,
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`  lead ${index} rejected: ${response.status} ${text.slice(0, 160)}`);
    return 'abandoned';
  }

  // Occasionally replay a submission, the way a flaky mobile network would.
  // These must NOT create duplicates - the dashboard proves it.
  if (Math.random() < 0.15) {
    await post('/api/leads', {
      contact: {
        first_name: firstName,
        last_name: lastName,
        email,
        phone: `415555${String(1000 + index).slice(-4)}`,
      },
      answers,
      attribution,
      client: { session_id: sessionId, event_id: conversionEventId, pixel_fired: true },
      idempotency_key: conversionEventId,
    });
  }

  return 'lead';
}

async function main(): Promise<void> {
  const count = Number(process.argv[2] ?? 40);

  try {
    const health = await fetch(`${API}/health`);
    if (!health.ok) throw new Error(String(health.status));
  } catch {
    console.error(`Cannot reach the API at ${API}. Start it first with: npm run dev:api`);
    process.exit(1);
  }

  console.log(`Seeding ${count} simulated visitors against ${API} ...`);

  let leads = 0;
  for (let i = 0; i < count; i += 1) {
    // Sequential on purpose: the lead endpoint is rate limited per IP, and a
    // burst would just exercise the limiter instead of seeding data.
    const result = await simulateVisitor(i);
    if (result === 'lead') leads += 1;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  console.log(`Done. ${leads} leads submitted from ${count} visitors.`);
  console.log(`Open http://localhost:5173/admin to see the funnel and automation health.`);
}

void main();
