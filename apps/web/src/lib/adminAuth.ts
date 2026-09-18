/**
 * Admin token handling.
 *
 * Deliberately NOT read from `import.meta.env`. A `VITE_`-prefixed variable is
 * inlined into the public JavaScript bundle, so shipping the admin token that
 * way would hand it to every visitor who loads the funnel - strictly worse than
 * having no token at all, because it looks protected.
 *
 * Instead the operator types it once and it lives in `sessionStorage`, scoped to
 * that tab and cleared when the tab closes.
 *
 * In production this whole mechanism is replaced by the company SSO / identity
 * proxy sitting in front of /admin; a shared secret is the right weight for an
 * internal ops view in a take-home, not for a real one.
 */

const STORAGE_KEY = 'dp_admin_token';

export function getAdminToken(): string {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setAdminToken(token: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, token.trim());
  } catch {
    // Storage disabled. The token stays in memory for this render only.
  }
}

export function clearAdminToken(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
