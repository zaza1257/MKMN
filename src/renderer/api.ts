import type { OpenNpuApi } from "../shared/api";

declare global {
  interface Window {
    opennpu: OpenNpuApi;
  }
}

export const api = (): OpenNpuApi => window.opennpu;

/**
 * Whether the renderer runs inside the Tauri WebView (as opposed to the
 * plain browser preview): the Tauri build has no office suite, so its export menu must
 * not offer formats only that suite can produce.
 */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
