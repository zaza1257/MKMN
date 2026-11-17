import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { Updater } from "../src/core/updater";

const root = path.resolve(__dirname, "..");
const read = (name: string) => fs.readFileSync(path.join(root, name), "utf8");

describe("MKMN release safety", () => {
  it("has a distinct Windows ARM64 identity and never publishes upstream", () => {
    const p = JSON.parse(read("package.json"));
    const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
    expect(p.name).toBe("mkmn");
    expect(tauri.productName).toBe("MKMN");
    expect(tauri.identifier).toBe("app.mkmn.desktop");
    expect(tauri.bundle.targets).toEqual(["nsis"]);
    expect(tauri.version).toBe(p.version); // one version across the app and the installer
  });

  it("all update entry points remain disabled and never request a network resource", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network allowed"));
    const changed = vi.fn();
    try {
      const updater = new Updater(changed);
      updater.start();
      expect(updater.enabled).toBe(false);
      expect((await updater.check()).status).toBe("error");
      expect((await updater.force()).status).toBe("error");
      updater.install();
      updater.stop();
      expect(fetcher).not.toHaveBeenCalled();
      expect(changed).toHaveBeenCalledTimes(3);
      expect(updater.current.checkedAt).toBeNull();
      expect(read("src/core/updater.ts")).not.toContain("electron-updater");
      expect(read("src/core/updater.ts")).not.toContain("child_process");
    } finally { fetcher.mockRestore(); }
  });

  it("retains the original license and conversation keys", () => {
    expect(read("LICENSE")).toContain("Copyright (c) 2026 Open NPU contributors");
    expect(read("src/renderer/store.ts")).toContain("opennpu");
  });

  it("does not silently install browser mock inference", () => {
    expect(read("src/renderer/main.tsx")).not.toContain("installMockIfNeeded");
  });

  it("confirms storage before the stable instance lock and before the app is built", () => {
    const lib = read("src-tauri/src/lib.rs");
    expect(lib.indexOf("paths::init_filesystem();")).toBeLessThan(lib.indexOf("single_instance::acquire()"));
    expect(lib.indexOf("single_instance::acquire()")).toBeLessThan(lib.indexOf("tauri::Builder::default()"));
    // a second launch exits before creating a sidecar, a WebView2 environment or a job object
    expect(lib).toContain("without starting a second instance");
  });
});
