import { describe, expect, it, vi, beforeEach } from "vitest";
import { saveConversations, loadConversations, resetConversations, type Conversation } from "../src/renderer/store";
import { streamComplete } from "../src/core/chat";
import { Workbook } from "../src/core/sheet";
import { documentText } from "../src/core/officeRead";
import { toBytes, writeZip } from "../src/core/zip";
import { Scheduler } from "../src/core/scheduler";
import { RuntimeLeaseManager } from "../src/core/lease";
import { judgePlacement, logPlacement } from "../src/core/placement";
import { energyPerToken, integratedWatts, type BatteryReading } from "../src/core/battery";
import { backendNote } from "../src/core/runtime";

describe("Auditor Findings Remediation (R1 - R12)", () => {
  const storeMap = new Map<string, string>();

  beforeEach(() => {
    storeMap.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storeMap.get(k) ?? null,
      setItem: (k: string, v: string) => storeMap.set(k, String(v)),
      removeItem: (k: string) => storeMap.delete(k),
      clear: () => storeMap.clear()
    });
  });

  // R1: Conversation persistence does not truncate past 100 entries
  it("R1: retains >100 conversations without silent truncation", () => {
    resetConversations();
    const convs: Conversation[] = [];
    for (let i = 0; i < 125; i++) {
      convs.push({
        id: `chat-${i}`,
        title: `Chat ${i}`,
        updated: 1000 + i,
        turns: [{ role: "user", content: `Hello from ${i}` }]
      });
    }
    saveConversations(convs);
    const loaded = loadConversations();
    expect(loaded.length).toBe(125);
    expect(loaded.find((c) => c.id === "chat-0")).toBeDefined();
    expect(loaded.find((c) => c.id === "chat-124")).toBeDefined();
  });

  // R6: Image attachments survive store save/load with dataUrl intact
  it("R6: preserves image dataUrl through conversation store roundtrip", () => {
    resetConversations();
    const sampleDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const conv: Conversation = {
      id: "vision-chat-1",
      title: "Vision Chat",
      updated: Date.now(),
      turns: [
        {
          role: "user",
          content: "Describe this image",
          attachments: [
            {
              name: "pixel.png",
              kind: "image",
              type: "image/png",
              size: 68,
              dataUrl: sampleDataUrl
            }
          ]
        }
      ]
    };
    saveConversations([conv]);
    const loaded = loadConversations();
    expect(loaded.length).toBe(1);
    expect(loaded[0].turns[0].attachments?.[0].dataUrl).toBe(sampleDataUrl);
  });

  // R7: Pre-aborted signal immediately halts chat before streaming
  it("R7: pre-aborted signal aborts immediately without starting inference", async () => {
    const ac = new AbortController();
    ac.abort();
    const events: any[] = [];
    const stream = streamComplete(
      {
        endpoint: "http://127.0.0.1:99999",
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        nctx: 2048,
        sampling: { max_tokens: 128 },
        signal: ac.signal
      },
      "chat-abort-test"
    );
    for await (const ev of stream) {
      events.push(ev);
    }
    expect(events.length).toBe(0);
  });

  // R4: ODS parser preserves repeated empty columns without shifting coordinates
  it("R4: OpenDocument spreadsheet preserves sparse column coordinates", async () => {
    const odsZip = await writeZip({
      mimetype: toBytes("application/vnd.oasis.opendocument.spreadsheet"),
      "content.xml": toBytes(`<?xml version="1.0"?>
<office:document-content xmlns:office="urn:o" xmlns:text="urn:t" xmlns:table="urn:tb">
  <office:body>
    <office:spreadsheet>
      <table:table table:name="SparseData">
        <table:table-row>
          <table:table-cell table:number-columns-repeated="3" />
          <table:table-cell office:value-type="float" office:value="9"><text:p>9</text:p></table:table-cell>
          <table:table-cell table:formula="of:=[.D1]*2"><text:p>18</text:p></table:table-cell>
        </table:table-row>
      </table:table>
    </office:spreadsheet>
  </office:body>
</office:document-content>`)
    });
    const doc = await documentText("sparse.ods", odsZip);
    expect(doc.text).toContain("## SparseData");
    expect(doc.text).toContain("=D1*2");
    expect(doc.text).toContain("= 18");
  });

  // R5: Spreadsheet formula AST decoupling and error-tolerant lazy evaluation
  it("R5: decoupled AST evaluates IF and IFERROR with short-circuiting", () => {
    const wb = new Workbook([
      {
        name: "TestSheet",
        rows: [
          ["=IF(FALSE, 1/0 + 1, 7)", "=IFERROR(1/0 + 1, 7)", "=IF(TRUE, 42, 1/0)", "=IFERROR(10/2, 999)"]
        ]
      }
    ]);
    expect(wb.cell("TestSheet", 0, 0)).toBe(7);
    expect(wb.cell("TestSheet", 0, 1)).toBe(7);
    expect(wb.cell("TestSheet", 0, 2)).toBe(42);
    expect(wb.cell("TestSheet", 0, 3)).toBe(5);
  });

  // R3: Hardware arbitration and Scheduler serialization
  it("R3: scheduler rejects runs when canRun is false and prevents concurrency", async () => {
    let canExecute = false;
    let runsCount = 0;
    const store = {
      items: [
        { id: "task-1", schedule: { kind: "once" as const, at: 1000 }, enabled: true, running: false, runs: [] },
        { id: "task-2", schedule: { kind: "once" as const, at: 1000 }, enabled: true, running: false, runs: [] }
      ],
      list() { return [...this.items]; },
      get(id: string) { return this.items.find((x) => x.id === id); },
      upsert(t: any) {
        const i = this.items.findIndex((x) => x.id === t.id);
        if (i >= 0) this.items[i] = t; else this.items.push(t);
        return t;
      }
    };
    const s = new Scheduler({
      store: store as any,
      canRun: () => canExecute,
      onChange: () => {},
      run: async () => {
        runsCount++;
        await new Promise((r) => setTimeout(r, 50));
        return { status: "ok" as const, output: "done", artifactIds: [] };
      }
    });

    // 1. When canRun() is false, execute() immediately returns null
    const rejected = await s.execute("task-1");
    expect(rejected).toBeNull();
    expect(runsCount).toBe(0);

    // 2. When canRun() is true, concurrent executions are serialized/prevented
    canExecute = true;
    const [r1, r2] = await Promise.all([
      s.execute("task-1"),
      s.execute("task-2")
    ]);
    expect(runsCount).toBe(1);
    expect((r1 !== null && r2 === null) || (r1 === null && r2 !== null)).toBe(true);
  });

  // R3: RuntimeLeaseManager arbitration
  it("R3: RuntimeLeaseManager grants single lease and queues subsequent requests", async () => {
    const mgr = new RuntimeLeaseManager();
    const l1 = mgr.acquire("chat", "Chat-1");
    expect(l1).not.toBeNull();
    expect(mgr.isBusy()).toBe(true);

    const l2 = mgr.acquire("task", "Task-1");
    expect(l2).toBeNull();

    l1!.release();
    expect(mgr.isBusy()).toBe(false);

    const l3 = mgr.acquire("bench", "Benchmark");
    expect(l3).not.toBeNull();
    l3!.release();
  });

  // R10: Placement validation requires successful generation
  it("R10: placement requires token generation success to certify NPU", () => {
    const failedPlacement = judgePlacement({
      asked: "npu",
      npuUtilPeak: 75,
      npuMemDeltaGB: 2.0,
      cpuBusyPct: 15,
      logHint: "npu",
      sizeGB: 4.0,
      generationSuccess: false,
      generatedTokens: 0
    });
    expect(failedPlacement.runsOn).toBe("unknown");
    expect(failedPlacement.evidence).toContain("Inference failed or generated 0 tokens: cannot certify NPU execution");

    const validPlacement = judgePlacement({
      asked: "npu",
      npuUtilPeak: 75,
      npuMemDeltaGB: 2.0,
      cpuBusyPct: 15,
      logHint: "npu",
      sizeGB: 4.0,
      generationSuccess: true,
      generatedTokens: 150
    });
    expect(validPlacement.runsOn).toBe("npu");

    expect(logPlacement(["device: HTP", "htp graph loaded"])).toBe("npu");
  });

  // R11: Time-integrated power telemetry using trapezoidal rule
  it("R11: power calculation integrates trapezoidally and validates duration", () => {
    const readings: BatteryReading[] = [
      { present: true, onMains: false, discharging: true, remainingMWh: 50000, fullMWh: 60000, dischargeMW: 10000, voltageMV: 12000, at: 0 },
      { present: true, onMains: false, discharging: true, remainingMWh: 49900, fullMWh: 60000, dischargeMW: 20000, voltageMV: 12000, at: 2000 },
      { present: true, onMains: false, discharging: true, remainingMWh: 49800, fullMWh: 60000, dischargeMW: 10000, voltageMV: 12000, at: 4000 }
    ];
    // Average Watts = integral of trapezoids / dt:
    // Seg 1 (0 to 2000ms): avg 15W * 2s
    // Seg 2 (2000 to 4000ms): avg 15W * 2s
    // Integrated watts should be 15W
    const w = integratedWatts(readings);
    expect(w).toBeCloseTo(15, 2);

    // Duration validation: 4000ms < 5s min requirement
    const energyShort = energyPerToken(readings.slice(0, 2), readings, 20, { minDurationSec: 5 });
    expect(energyShort?.problem).toMatch(/Run too short/);
    expect(energyShort?.mWhPerToken).toBeNull();
  });

  // Claims clean-up: runtime.ts:73 does not make unqualified marketing claims
  it("Claims: runtime note uses objective hardware description", () => {
    const note = backendNote("npu");
    expect(note).not.toContain("Fastest and lightest on the battery");
    expect(note).toContain("Offloads model compute to dedicated neural hardware");
  });
});

describe("lease timeout and deleted tasks", () => {
  it("a queued lease that times out rejects and leaves the queue", async () => {
    const mgr = new RuntimeLeaseManager();
    const l1 = mgr.acquire("chat", "Chat-1")!;
    const wait = mgr.acquireOrWait("task", "Task-1", 30);
    await expect(wait).rejects.toThrow(/lease timeout/);
    // the lease is still held by the chat, and the timed-out waiter is gone from the queue
    expect(mgr.currentOwner()).toBe(l1);
    l1!.release();
    expect(mgr.isBusy()).toBe(false);
  });

  it("a task deleted while it ran stays deleted (nothing is written back)", async () => {
    let deleted = false;
    const store = {
      items: [{ id: "t1", schedule: { kind: "once" as const, at: 1000 }, enabled: true, running: false, runs: [] as unknown[] }],
      list() { return [...this.items]; },
      get(id: string) { return deleted ? undefined : this.items.find((x) => x.id === id); },
      upsert(t: any) {
        const i = this.items.findIndex((x) => x.id === t.id);
        if (i >= 0) this.items[i] = t; else this.items.push(t);
        writes.push(t);
        return t;
      }
    };
    const writes: any[] = [];
    const s = new Scheduler({
      store: store as any,
      canRun: () => true,
      onChange: () => undefined,
      run: async () => { deleted = true; return { status: "ok" as const, output: "done", artifactIds: [] }; }
    });
    const run = await s.execute("t1");
    expect(run).not.toBeNull();
    expect(store.items).toHaveLength(1);           // no resurrection
    expect(writes).toHaveLength(1);                // only the "running" mark, nothing after the delete
  });
});
