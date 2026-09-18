/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_META_PIXEL_ID?: string;
  readonly VITE_FUNNEL_VERSION?: string;
  readonly VITE_TRACKING_DEBUG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
