/**
 * Browser configuration.
 *
 * Only VITE_* variables are inlined into the bundle, which is the guardrail
 * that keeps the Meta *access token* server-side. The Pixel id is public by
 * design - it ships in the pixel snippet on every advertiser's site.
 */
export const webEnv = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000',
  metaPixelId: import.meta.env.VITE_META_PIXEL_ID ?? '',
  funnelVersion: import.meta.env.VITE_FUNNEL_VERSION ?? 'qualification-v1',
  trackingDebug: (import.meta.env.VITE_TRACKING_DEBUG ?? 'true') === 'true',
} as const;
