# Assumptions, Trade-offs & Additional Work

## Assumptions

I treated the reference funnel as a UX reference rather than a
pixel-perfect implementation. The core interaction model—one
question at a time with progressive qualification—was preserved.

I assumed n8n would act as the orchestration layer and Airtable as
the operational lead store, while the application backend owns
validation, identifiers, attribution and integration boundaries.

## Key Trade-offs

### Configuration-driven funnel
The questions and branching rules are configuration-driven rather
than implemented as independent pages. This makes the funnel easier
to maintain and modify as qualification logic changes.

### Browser + server-side Meta tracking
I implemented a browser/server tracking architecture using a shared
event ID for conversion deduplication. This provides a more robust
conversion signal than relying exclusively on browser-side tracking.

### Idempotency
Lead and event identifiers are used to make webhook processing
idempotent. Repeated delivery of the same event should not create
duplicate operational records.

### Failure handling
External integrations are treated as unreliable dependencies.
Failures are surfaced and retried rather than silently discarded.

### Privacy
Because the funnel collects sensitive qualification information,
detailed responses are kept within the application's controlled
data layer rather than being unnecessarily passed to Meta.

## Additional Work

I added:
- resume/autosave behavior
- validation and rate limiting
- mock integration mode
- failure injection for testing
- retry/outbox behavior
- operational event logging
- responsive and accessible UI
- automated tests for critical processing logic

## Future Improvements

With more time, I would move the file-backed operational state to
a durable managed database, add richer operational monitoring and
expand automated integration testing against external services.
