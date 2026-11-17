import { describe, expect, it } from "vitest";
import { normalizeCloseAction } from "../src/shared/settings";

describe("normalizeCloseAction (the unified close setting)", () => {
  it("defaults to quitting the application when nothing was saved", () => {
    expect(normalizeCloseAction({})).toEqual({ closeAction: "quit", minimizeToTrayRemoved: true });
  });

  it("preserves an explicit legacy tray choice", () => {
    expect(normalizeCloseAction({ minimizeToTray: true })).toEqual({ closeAction: "tray", minimizeToTrayRemoved: true });
  });

  it("maps legacy false to quit", () => {
    expect(normalizeCloseAction({ minimizeToTray: false }).closeAction).toBe("quit");
  });

  it("keeps a saved closeAction and reports the legacy key for removal", () => {
    expect(normalizeCloseAction({ closeAction: "quit", minimizeToTray: true })).toEqual({ closeAction: "quit", minimizeToTrayRemoved: true });
    expect(normalizeCloseAction({ closeAction: "tray" })).toEqual({ closeAction: "tray", minimizeToTrayRemoved: false });
  });

  it("replaces invalid values with the quit default", () => {
    expect(normalizeCloseAction({ closeAction: "minimize" }).closeAction).toBe("quit");
    expect(normalizeCloseAction({ closeAction: 42 }).closeAction).toBe("quit");
  });

  it("does not mutate its input", () => {
    const saved: Record<string, unknown> = { minimizeToTray: true };
    normalizeCloseAction(saved);
    expect(saved).toEqual({ minimizeToTray: true });
  });
});
