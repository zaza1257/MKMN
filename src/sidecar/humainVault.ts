import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { HumainProvider } from "../shared/humain";

const credentials = new Set(["fuse", "node"]);

function transform(value: string, encrypt: boolean): Promise<string> {
  if (process.platform !== "win32") throw new Error("HUMAIN credential storage requires Windows.");
  const script = encrypt
    ? "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$null,'CurrentUser'))"
    : "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,'CurrentUser'))";
  const exe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); [Console]::Write((${script}))`],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"], signal: AbortSignal.timeout(15_000) });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    const failed = () => reject(new Error("Windows could not access the HUMAIN credential."));
    child.on("error", failed);
    child.stdin.on("error", failed);
    child.on("close", (code) => code === 0 && output ? resolve(output) : failed());
    child.stdin.end(value);
  });
}

export function humainVault(configDir: string) {
  const location = (id: HumainProvider) => {
    if (!credentials.has(id)) throw new Error("Unknown HUMAIN credential.");
    return path.join(configDir, "Humain", `${id}.dpapi`);
  };
  return {
    async exists(id: HumainProvider) {
      return fs.stat(location(id)).then((stat) => stat.isFile(), () => false);
    },
    async read(id: HumainProvider) {
      const file = location(id);
      const sealed = await fs.readFile(file, "utf8").catch((e) => {
        if (e.code === "ENOENT") throw new Error("Save the HUMAIN API key in Settings first.");
        throw new Error("Windows could not read the HUMAIN credential.");
      });
      return transform(sealed, false);
    },
    async save(id: HumainProvider, value: string | null) {
      const file = location(id);
      if (value === null) {
        await fs.rm(file, { force: true });
        return;
      }
      const key = typeof value === "string" ? value.trim() : "";
      if (!/^[!-~]{1,4096}$/.test(key)) throw new Error("Enter a valid API key.");
      const sealed = await transform(key, true);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, sealed, { flag: "wx" });
        await fs.rename(temp, file);
      } finally {
        await fs.rm(temp, { force: true });
      }
    },
  };
}
