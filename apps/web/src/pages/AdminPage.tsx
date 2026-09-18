import { useCallback, useEffect, useState } from 'react';
import {
  drainOutbox,
  getAdminJobs,
  getAdminLeads,
  getAdminMetrics,
  retryJob,
  setFailureInjection,
  type AdminJob,
  type AdminLead,
  type AdminMetrics,
} from '../lib/api.js';
import { AlertIcon, SpinnerIcon } from '../components/ui/Icons.js';
import { clearAdminToken, getAdminToken, setAdminToken } from '../lib/adminAuth.js';

/**
 * Internal operations view.
 *
 * Scoped to the two questions an operator actually asks:
 *   "Is the funnel converting?"  and  "Is anything broken right now?"
 *
 * It is not a BI tool. Growth analysis belongs in a warehouse; this exists so
 * that a failure is noticed in seconds and can be replayed in one click.
 */
export function AdminPage() {
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [jobs, setJobs] = useState<AdminJob[]>([]);
  const [leads, setLeads] = useState<AdminLead[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Null until we know; false means the token was rejected or never entered.
  const [authorised, setAuthorised] = useState<boolean | null>(null);
  const [tokenInput, setTokenInput] = useState('');

  const load = useCallback(async () => {
    try {
      const [metricsResult, jobsResult, leadsResult] = await Promise.all([
        getAdminMetrics(),
        getAdminJobs(),
        getAdminLeads(),
      ]);
      setMetrics(metricsResult);
      setJobs(jobsResult.jobs);
      setLeads(leadsResult.leads);
      setAuthorised(true);
      setError(null);
    } catch (loadError) {
      const status = (loadError as { status?: number }).status;
      if (status === 401) {
        // Stale or wrong token: drop it and fall back to the prompt.
        clearAdminToken();
        setAuthorised(false);
        setError(null);
        return;
      }
      setAuthorised(getAdminToken() ? true : false);
      setError(loadError instanceof Error ? loadError.message : 'Failed to load metrics');
    }
  }, []);

  useEffect(() => {
    if (!getAdminToken()) {
      setAuthorised(false);
      return;
    }

    void load();
    // A 5s refresh is enough to watch a retry land during a demo without
    // hammering the API.
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load, authorised]);

  const runAction = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await action();
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  // The token is never compiled into the bundle - the operator supplies it.
  if (authorised === false) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-canvas p-6">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!tokenInput.trim()) return;
            setAdminToken(tokenInput);
            setTokenInput('');
            setAuthorised(null);
            void load();
          }}
          className="w-full max-w-sm rounded-2xl border border-ink/10 bg-white p-6 shadow-card"
        >
          <h1 className="text-xl font-extrabold text-ink">Funnel Operations</h1>
          <p className="mt-2 text-sm text-ink-muted">
            Enter the admin token to continue. It is held for this browser tab only and is never
            built into the public bundle.
          </p>

          <label htmlFor="admin-token" className="mt-5 mb-1.5 block text-sm font-semibold text-ink-soft">
            Admin token
          </label>
          <input
            id="admin-token"
            type="password"
            autoComplete="off"
            className="field-input"
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
            placeholder="ADMIN_API_TOKEN"
          />

          <button type="submit" className="primary-cta mt-4">
            Unlock dashboard
          </button>

          {/* Deliberately names the variable rather than printing its default
              value - a hint string is still a string that ships to every
              visitor in the production bundle. */}
          <p className="mt-4 text-xs text-ink-muted">
            This is the value of <code className="rounded bg-ink/5 px-1">ADMIN_API_TOKEN</code> in
            your <code className="rounded bg-ink/5 px-1">.env</code>.
          </p>
        </form>
      </div>
    );
  }

  if (error && !metrics) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-canvas p-6">
        <div className="max-w-md rounded-2xl border-2 border-red-200 bg-red-50 p-6 text-center">
          <p className="font-bold text-red-900">Could not load the dashboard</p>
          <p className="mt-2 text-sm text-red-800">{error}</p>
          <button
            type="button"
            onClick={() => {
              clearAdminToken();
              setAuthorised(false);
            }}
            className="mt-4 text-sm font-bold text-red-900 underline"
          >
            Re-enter token
          </button>
        </div>
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-canvas">
        <SpinnerIcon className="h-8 w-8 text-brand-600" />
      </div>
    );
  }

  const { funnel, automation } = metrics;
  const health = automation.dead_letter > 0 ? 'degraded' : 'healthy';

  const funnelRows: { label: string; value: number; rate?: number }[] = [
    { label: 'Visitors', value: funnel.visitors },
    { label: 'Saw question 1', value: funnel.qualification_started },
    {
      label: 'Answered question 1',
      value: funnel.funnel_started,
      rate: funnel.conversion_rates.render_to_engage,
    },
    { label: 'Qualification completed', value: funnel.qualification_completed },
    {
      label: 'Email captured',
      value: funnel.email_captured,
      rate: funnel.conversion_rates.start_to_email,
    },
    {
      label: 'Lead submitted',
      value: funnel.lead_submitted,
      rate: funnel.conversion_rates.email_to_lead,
    },
  ];

  return (
    <div className="min-h-[100dvh] bg-canvas p-4 sm:p-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-extrabold text-ink">Funnel Operations</h1>
            <p className="mt-1 text-sm text-ink-muted">
              Updated {new Date(metrics.generated_at).toLocaleTimeString()} · auto-refresh 5s
            </p>
          </div>

          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-bold
                ${
                  health === 'healthy'
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-amber-50 text-amber-800'
                }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  health === 'healthy' ? 'bg-emerald-500' : 'bg-amber-500'
                }`}
              />
              {health}
            </span>

            <button
              type="button"
              onClick={() => void runAction('drain', drainOutbox)}
              disabled={busy !== null}
              className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-brand-700 disabled:opacity-50"
            >
              {busy === 'drain' ? 'Draining...' : 'Drain outbox'}
            </button>
          </div>
        </header>

        {/* --- Funnel --------------------------------------------------- */}
        <section aria-labelledby="funnel-heading" className="mb-8">
          <h2 id="funnel-heading" className="mb-3 text-sm font-bold uppercase tracking-wide text-ink-muted">
            Funnel
          </h2>
          <div className="overflow-hidden rounded-2xl border border-ink/10 bg-white shadow-card">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Funnel step counts and conversion rates</caption>
              <thead className="border-b border-ink/10 bg-ink/[0.02]">
                <tr>
                  <th scope="col" className="px-5 py-3 font-semibold text-ink-muted">Stage</th>
                  <th scope="col" className="px-5 py-3 text-right font-semibold text-ink-muted">Count</th>
                  <th scope="col" className="px-5 py-3 text-right font-semibold text-ink-muted">Step rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink/5">
                {funnelRows.map((row) => (
                  <tr key={row.label}>
                    <th scope="row" className="px-5 py-3 font-semibold text-ink">{row.label}</th>
                    <td className="px-5 py-3 text-right font-mono text-base font-bold text-ink">
                      {row.value.toLocaleString()}
                    </td>
                    <td className="px-5 py-3 text-right text-ink-muted">
                      {row.rate === undefined ? '—' : `${row.rate}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Qualified" value={funnel.qualified} tone="good" />
            <Stat label="Needs review" value={funnel.review} />
            <Stat label="Disqualified" value={funnel.disqualified} />
            <Stat
              label="Visit → Lead"
              value={`${funnel.conversion_rates.visit_to_lead}%`}
              tone="accent"
            />
          </div>
        </section>

        {/* --- Automation health ---------------------------------------- */}
        <section aria-labelledby="automation-heading" className="mb-8">
          <h2 id="automation-heading" className="mb-3 text-sm font-bold uppercase tracking-wide text-ink-muted">
            Automation health
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <Stat label="Meta events sent" value={automation.meta_events_succeeded} tone="good" />
            <Stat
              label="Meta events failed"
              value={automation.meta_events_failed}
              tone={automation.meta_events_failed > 0 ? 'bad' : undefined}
            />
            <Stat label="Airtable writes" value={automation.airtable_writes_succeeded} tone="good" />
            <Stat
              label="Airtable failed"
              value={automation.airtable_writes_failed}
              tone={automation.airtable_writes_failed > 0 ? 'bad' : undefined}
            />
            <Stat label="Retries pending" value={automation.retries_pending} />
            <Stat
              label="Dead letter"
              value={automation.dead_letter}
              tone={automation.dead_letter > 0 ? 'bad' : undefined}
            />
            <Stat label="Duplicates prevented" value={automation.duplicates_prevented} tone="accent" />
            <Stat
              label="Awaiting CRM sync"
              value={automation.leads_awaiting_crm_sync}
              tone={automation.leads_awaiting_crm_sync > 0 ? 'warn' : undefined}
            />
          </div>
        </section>

        {/* --- Failure injection ---------------------------------------- */}
        <section aria-labelledby="chaos-heading" className="mb-8">
          <h2 id="chaos-heading" className="mb-3 text-sm font-bold uppercase tracking-wide text-ink-muted">
            Failure injection (mock mode)
          </h2>
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-ink/10 bg-white p-4 shadow-card">
            {(['airtable', 'n8n', 'meta'] as const).map((integration) => {
              const active = Boolean(metrics.failure_injection[integration]);
              return (
                <button
                  key={integration}
                  type="button"
                  aria-pressed={active}
                  disabled={busy !== null}
                  onClick={() =>
                    void runAction(integration, () => setFailureInjection(integration, !active))
                  }
                  className={`rounded-xl border-2 px-4 py-2 text-sm font-bold transition disabled:opacity-50
                    ${
                      active
                        ? 'border-red-300 bg-red-50 text-red-700'
                        : 'border-ink/10 bg-white text-ink-soft hover:border-brand-300'
                    }`}
                >
                  {integration}: {active ? 'FAILING' : 'healthy'}
                </button>
              );
            })}
            <p className="ml-auto text-xs text-ink-muted">
              Toggle a service to failing, submit a lead, then watch the retry and recovery below.
            </p>
          </div>
        </section>

        {/* --- Outbox --------------------------------------------------- */}
        <section aria-labelledby="jobs-heading" className="mb-8">
          <h2 id="jobs-heading" className="mb-3 text-sm font-bold uppercase tracking-wide text-ink-muted">
            Outbox / automation runs
          </h2>
          <div className="overflow-x-auto rounded-2xl border border-ink/10 bg-white shadow-card">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-ink/10 bg-ink/[0.02]">
                <tr>
                  {['Job', 'Type', 'Status', 'Attempts', 'Last error', ''].map((heading) => (
                    <th key={heading} scope="col" className="px-4 py-3 font-semibold text-ink-muted">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink/5">
                {jobs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-ink-muted">
                      No automation runs yet. Complete the funnel to generate one.
                    </td>
                  </tr>
                ) : (
                  jobs.map((job) => (
                    <tr key={job.job_id}>
                      <td className="px-4 py-3 font-mono text-xs text-ink-muted">
                        {job.job_id.slice(0, 12)}…
                      </td>
                      <td className="px-4 py-3 font-semibold text-ink">{job.type}</td>
                      <td className="px-4 py-3">
                        <StatusPill status={job.status} />
                      </td>
                      <td className="px-4 py-3 font-mono text-ink-soft">
                        {job.attempts}/{job.max_attempts}
                      </td>
                      <td className="max-w-[260px] truncate px-4 py-3 text-xs text-red-700">
                        {job.last_error ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {job.status === 'dead_letter' || job.status === 'failed' ? (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void runAction(job.job_id, () => retryJob(job.job_id))}
                            className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-brand-700 disabled:opacity-50"
                          >
                            {busy === job.job_id ? 'Retrying…' : 'Retry'}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* --- Leads ---------------------------------------------------- */}
        <section aria-labelledby="leads-heading">
          <h2 id="leads-heading" className="mb-3 text-sm font-bold uppercase tracking-wide text-ink-muted">
            Recent leads
          </h2>
          <div className="overflow-x-auto rounded-2xl border border-ink/10 bg-white shadow-card">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-ink/10 bg-ink/[0.02]">
                <tr>
                  {['Lead', 'Contact', 'Outcome', 'Score', 'Source', 'CRM'].map((heading) => (
                    <th key={heading} scope="col" className="px-4 py-3 font-semibold text-ink-muted">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink/5">
                {leads.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-ink-muted">
                      No leads yet.
                    </td>
                  </tr>
                ) : (
                  leads.map((lead) => (
                    <tr key={lead.lead_id}>
                      <td className="px-4 py-3 font-mono text-xs text-ink-muted">
                        {lead.lead_id.slice(0, 12)}…
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-semibold text-ink">{lead.name}</span>
                        <span className="block text-xs text-ink-muted">{lead.email_masked}</span>
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill status={lead.qualification_outcome} />
                      </td>
                      <td className="px-4 py-3 font-mono font-bold text-ink">
                        {lead.qualification_score}
                      </td>
                      <td className="px-4 py-3 text-ink-soft">{lead.utm_source ?? 'direct'}</td>
                      <td className="px-4 py-3">
                        {lead.synced_to_crm ? (
                          <span className="text-xs font-bold text-emerald-700">synced</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-bold text-amber-700">
                            <AlertIcon className="h-3.5 w-3.5" />
                            pending
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <footer className="mt-8 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-muted">
          {Object.entries(metrics.integrations).map(([key, value]) => (
            <span key={key}>
              <strong className="font-semibold text-ink-soft">{key}:</strong> {value}
            </span>
          ))}
        </footer>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: 'good' | 'bad' | 'warn' | 'accent';
}) {
  const toneClass =
    tone === 'good'
      ? 'text-emerald-700'
      : tone === 'bad'
        ? 'text-red-600'
        : tone === 'warn'
          ? 'text-amber-700'
          : tone === 'accent'
            ? 'text-brand-700'
            : 'text-ink';

  return (
    <div className="rounded-2xl border border-ink/10 bg-white p-4 shadow-card">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</p>
      <p className={`mt-1 font-mono text-2xl font-extrabold ${toneClass}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    succeeded: 'bg-emerald-50 text-emerald-700',
    qualified: 'bg-emerald-50 text-emerald-700',
    pending: 'bg-slate-100 text-slate-700',
    in_progress: 'bg-blue-50 text-blue-700',
    review: 'bg-blue-50 text-blue-700',
    failed: 'bg-amber-50 text-amber-800',
    dead_letter: 'bg-red-50 text-red-700',
    disqualified: 'bg-slate-100 text-slate-600',
    duplicate: 'bg-purple-50 text-purple-700',
    skipped: 'bg-slate-100 text-slate-500',
  };

  return (
    <span
      className={`inline-block rounded-full px-2.5 py-1 text-xs font-bold ${
        map[status] ?? 'bg-slate-100 text-slate-700'
      }`}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}
