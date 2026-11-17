export type AppearanceMode = "light" | "dark" | "system";

export const APPEARANCE_KEY = "mkmn.appearance";

export function normalizeAppearance(value: unknown): AppearanceMode {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function storedAppearance(): AppearanceMode {
  try { return normalizeAppearance(localStorage.getItem(APPEARANCE_KEY)); } catch { return "system"; }
}

export function applyAppearance(value: unknown): void {
  const mode = normalizeAppearance(value);
  const dark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  try { localStorage.setItem(APPEARANCE_KEY, mode); } catch { /* storage may be unavailable */ }
}

export function subscribeToSystemAppearance(onChange: () => void): () => void {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => onChange();
  query.addEventListener?.("change", handler);
  return () => query.removeEventListener?.("change", handler);
}
