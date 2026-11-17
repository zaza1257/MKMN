import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_METRICS,
  ObservationFeed,
  TimeoutError,
  formatAccelerator,
  formatPercent,
  formatProcessCpu,
  formatProcessRam,
  formatUtilization,
  initialObservation,
  lastUpdatedText,
  livePills,
  metricsAreLive,
  observeFailure,
  observeSuccess,
  observationPhase,
  phaseView,
  phaseViewSame,
  statusBadgeKind,
  withTimeout,
  type Observation,
  type SystemMetricsPayload,
} from "../src/renderer/metricsModel";

/**
 * Tests of the production titlebar metrics model (src/renderer/metricsModel.ts, used by
 * TitlebarMetrics.tsx) against payloads shaped exactly like the JSON the Rust monitor
 * emits over the bridge (src-tauri/src/monitor.rs serde names). The sample payload is a
 * fixture for the wire contract; the live/unavailable detection, badge classification and
 * formatting it feeds are the real renderer code.
 */

// The payload exactly as the Rust `get_system_metrics` command / `metrics_update` event
// serializes it (camelCase serde renames, monitor.rs field order), decoded like the HUD
// decodes it.
const samplePayload: SystemMetricsPayload = JSON.parse(`{
  "timestamp": ${Date.now()},
  "processes": [
    { "pid": 13912, "parentPid": 0, "name": "MKMN Host (Tauri v2 + WebView2)", "role": "host", "depth": 0,
      "cpuPercent": 1.2, "ramBytes": 33554432, "ramMB": 32.0, "ramPercent": 0.1, "npuPercent": 0.0, "gpuPercent": 0.2, "status": "Normal" },
    { "pid": 14208, "parentPid": 13912, "name": "Edge WebView2 Renderer", "role": "webview", "depth": 1,
      "cpuPercent": 0.8, "ramBytes": 68157440, "ramMB": 65.0, "ramPercent": 0.2, "npuPercent": 0.0, "gpuPercent": 0.1, "status": "Normal" },
    { "pid": 10124, "parentPid": 13912, "name": "GenieX Inference (geniex.exe)", "role": "geniex", "depth": 0,
      "cpuPercent": 4.1, "ramBytes": 1845493760, "ramMB": 1760.0, "ramPercent": 5.5, "npuPercent": 85.0, "gpuPercent": 0.0, "status": "⚡ Hexagon HTP (Active)" },
    { "pid": 8840, "parentPid": 13912, "name": "Voice Worker (sherpa-onnx)", "role": "voice", "depth": 0,
      "cpuPercent": 0.0, "ramBytes": 47185920, "ramMB": 45.0, "ramPercent": 0.1, "npuPercent": 0.0, "gpuPercent": 0.0, "status": "Standby" }
  ],
  "mkmnTotal": { "cpuPercent": 6.1, "ramBytes": 1994391552, "ramMB": 1902.0, "ramPercent": 5.9, "npuPercent": 85.0, "gpuPercent": 0.3, "status": "Active" },
  "systemTotal": { "cpuPercent": 14.0, "ramTotalBytes": 34359738368, "ramUsedBytes": 8804682956, "ramTotalGB": 32.0,
                   "ramUsedGB": 8.2, "ramPercent": 25.6, "npuPercent": 30.0, "gpuPercent": 40.0,
                   "npuAvailable": true, "gpuAvailable": true,
                   "powerStatus": "Plugged In", "powerRating": "Activity Low" },
  "pills": { "power": "Activity Low", "powerTooltip": "AC Power · Plugged In", "cpu": "CPU 6.1%", "cpuVal": 6.1,
             "gpu": "GPU 0.3%", "gpuVal": 0.3, "npu": "NPU 85%", "npuVal": 85.0, "npuActive": true,
             "ram": "RAM 5.9%", "ramVal": 5.9, "ramMB": 1902.0 },
  "memoryNote": "Private memory (commit charge); shared pages counted once",
  "unopenedProcesses": 0,
  "engines": [
    { "adapterClass": "npu", "adapter": "Snapdragon(R) X2 Elite - X2E88100 - Qualcomm(R) Hexagon(TM) NPU",
      "luid": "luid_0x00000000_0x00010f31", "phys": 0, "eng": 0, "engineType": "compute", "percent": 30.0 },
    { "adapterClass": "gpu", "adapter": "Qualcomm(R) Adreno(TM) X2-90 GPU",
      "luid": "luid_0x00000000_0x00010c23", "phys": 0, "eng": 0, "engineType": "3d", "percent": 40.0 }
  ]
}`);

describe("Metrics payload wire contract (Rust monitor -> HUD)", () => {
  it("accepts the payload the Rust monitor emits and treats it as a live measurement", () => {
    expect(metricsAreLive(samplePayload)).toBe(true);
    expect(samplePayload.processes).toHaveLength(4);
  });

  it("reports the process tree without duplicate PIDs and with a consistent hierarchy", () => {
    const pids = samplePayload.processes.map((p) => p.pid);
    expect(new Set(pids).size).toBe(pids.length);
    const host = samplePayload.processes.find((p) => p.role === "host")!;
    const webview = samplePayload.processes.find((p) => p.role === "webview")!;
    expect(webview.parentPid).toBe(host.pid);
    expect(webview.depth).toBe(1);
    for (const proc of samplePayload.processes) {
      if (proc.pid !== host.pid) {
        expect(proc.parentPid, `${proc.name} must belong to the host`).toBe(host.pid);
      }
    }
  });

  it("carries every field the HUD's pills and table read", () => {
    expect(samplePayload.pills.power).toBeTypeOf("string");
    expect(samplePayload.pills.cpu).toBeTypeOf("string");
    expect(samplePayload.pills.npuVal).toBe(samplePayload.mkmnTotal.npuPercent);
    expect(samplePayload.pills.ramMB).toBe(samplePayload.mkmnTotal.ramMB);
    expect(typeof samplePayload.memoryNote).toBe("string");
    expect(samplePayload.unopenedProcesses).toBeTypeOf("number");
    expect(Array.isArray(samplePayload.engines)).toBe(true);
  });

  // M03: the system row is the MACHINE's measurement, the MKMN row the app's —
  // two different scopes that may legitimately differ, and must not be copies.
  it("reports the system row from its own scope, not as a copy of the app's", () => {
    expect(samplePayload.systemTotal.npuPercent).not.toBe(samplePayload.mkmnTotal.npuPercent);
    expect(samplePayload.systemTotal.gpuPercent).not.toBe(samplePayload.mkmnTotal.gpuPercent);
    // the app's share can never exceed the machine's busiest engine
    expect(samplePayload.mkmnTotal.npuPercent).toBeLessThanOrEqual(100);
  });

  it("marks NPU inference active when the Hexagon HTP engine is pegged", () => {
    expect(samplePayload.pills.npuActive).toBe(true);
    expect(samplePayload.pills.npu).toBe("NPU 85%");
    expect(samplePayload.processes.find((p) => p.role === "geniex")!.npuPercent).toBeGreaterThan(70);
  });
});

describe("Stale telemetry (M08: a payload older than 30 s is not live)", () => {
  it("accepts a fresh payload", () => {
    const fresh = { ...samplePayload, timestamp: Date.now() };
    expect(metricsAreLive(fresh)).toBe(true);
  });

  it("refuses a payload 31 s old — the flyout must not show it as numbers", () => {
    const stale = { ...samplePayload, timestamp: Date.now() - 31_000 };
    expect(metricsAreLive(stale)).toBe(false);
  });

  it("accepts a payload just inside the window, at any cadence", () => {
    // the hidden cadence samples every 10 s: a 10 s-old payload is current
    const justSampled = { ...samplePayload, timestamp: Date.now() - 10_000 };
    expect(metricsAreLive(justSampled)).toBe(true);
  });

  it("honors an explicit now (pure time comparison)", () => {
    const at = 1_000_000;
    const payload = { ...samplePayload, timestamp: at - 5_000 };
    expect(metricsAreLive(payload, at)).toBe(true);
    expect(metricsAreLive(payload, at + 26_000)).toBe(false);
  });

  it("refuses a timestamp of 0 (never sampled)", () => {
    expect(metricsAreLive({ ...samplePayload, timestamp: 0 })).toBe(false);
  });
});

describe("Accelerator availability formatting (M05: N/A is not a 0%)", () => {
  it("shows the number when live and available", () => {
    expect(formatAccelerator(30.0, true, true)).toBe("30%");
    expect(formatAccelerator(0.4, true, true, 1)).toBe("0.4%");
    // an idle-but-supported accelerator is a measured zero, shown as one
    expect(formatAccelerator(0.0, true, true)).toBe("0%");
  });

  it("shows N/A — never a measured-looking zero — when unavailable", () => {
    expect(formatAccelerator(0.0, true, false)).toBe("N/A");
    expect(formatAccelerator(85.0, true, false)).toBe("N/A");
  });

  it("keeps older backends without the flag working", () => {
    expect(formatAccelerator(30.0, true, undefined)).toBe("30%");
  });
});

describe("Unavailable telemetry (production DEFAULT_METRICS)", () => {
  it("shows nothing that was never measured before the first payload arrives", () => {
    expect(metricsAreLive(DEFAULT_METRICS)).toBe(false);
    expect(DEFAULT_METRICS.processes).toEqual([]);
    expect(DEFAULT_METRICS.pills.cpu).toBe("CPU —");
    expect(DEFAULT_METRICS.pills.npu).toBe("NPU —");
    expect(DEFAULT_METRICS.pills.npuActive).toBe(false);
    expect(DEFAULT_METRICS.systemTotal.powerStatus).toBe("Unknown");
  });
  it("a payload with a timestamp but no measured processes is still unavailable", () => {
    expect(metricsAreLive({ ...DEFAULT_METRICS, timestamp: Date.now(), pills: { ...DEFAULT_METRICS.pills, cpu: "CPU 0.0%" } })).toBe(false);
  });

  it("percent formatting reads the real value when live and an em dash when not", () => {
    expect(formatPercent(6.1, true)).toBe("6.1%");
    expect(formatPercent(6.1, false)).toBe("—");
    expect(formatUtilization(85.0, true)).toBe("85%");
    expect(formatUtilization(85.0, false)).toBe("—");
  });
});

describe("Stale-readout honesty (M08): every number is gated on freshness", () => {
  it("a stale payload reads the em-dash pills everywhere, never minutes-old numbers", () => {
    const stale = livePills(samplePayload.pills, false);
    expect(stale.cpu).toBe("CPU —");
    expect(stale.gpu).toBe("GPU —");
    expect(stale.npu).toBe("NPU —");
    expect(stale.ram).toBe("RAM —");
    expect(stale.power).toBe("—");
    expect(stale.npuActive).toBe(false); // the NPU animation must not pulse on stale data
  });
  it("a live payload passes through untouched, availability labels included", () => {
    const p = livePills(samplePayload.pills, true);
    expect(p).toBe(samplePayload.pills);
    // "NPU N/A" is the backend's counter-availability verdict, emitted as the pill
    // string itself: livePills must not rewrite it (staleness is the only thing it owns).
    const na = livePills({ ...samplePayload.pills, npu: "NPU N/A", npuVal: -1, npuActive: false }, true);
    expect(na.npu).toBe("NPU N/A");
  });
  it("per-process CPU and RAM read the real values only when live", () => {
    const proc = samplePayload.processes[2]; // geniex, 4.1% CPU, 1760 MB
    expect(formatProcessCpu(proc.cpuPercent, true)).toBe("4.1%");
    expect(formatProcessCpu(proc.cpuPercent, false)).toBe("—");
    expect(formatProcessRam(proc, true)).toBe("1760 MB (5.5%)");
    expect(formatProcessRam(proc, false)).toBe("—");
  });
  it("a process whose RAM could not be read is an em dash even when live (never a guess)", () => {
    const unreadable = { ramMB: 0, ramPercent: 0 };
    expect(formatProcessRam(unreadable, true)).toBe("—");
    expect(formatProcessRam(unreadable, false)).toBe("—");
  });
});

describe("Status badge classification (production statusBadgeKind)", () => {
  it("renders Windows Efficiency Mode processes as the EcoQoS badge", () => {
    expect(statusBadgeKind("🍃 EcoQoS")).toBe("eco");
  });

  it("renders Hexagon inference states as the HTP badge, active or idle", () => {
    expect(statusBadgeKind("⚡ Hexagon HTP (Active)")).toBe("htp");
    expect(statusBadgeKind("⚡ Hexagon HTP")).toBe("htp");
  });

  it("renders everything else as the plain status text", () => {
    expect(statusBadgeKind("Normal")).toBe("plain");
    expect(statusBadgeKind("Standby")).toBe("plain");
    expect(statusBadgeKind("Active")).toBe("plain");
  });
});

// ------------------------------------------------------------------ poll-fed observations
// The status panel's meters and server status are poll-fed readings. These pin the
// observation contract in src/renderer/metricsModel.ts: last good reading kept apart
// from the measurement, unchanged readings still count as fresh, expiry past the 30 s
// contract, and a backend whose companion feed fails too reading as disconnected.

type M = { ramPercent: number };

const obs0 = <T,>(): Observation<T> => initialObservation<T>();

describe("Observation model (last good reading kept apart from the values)", () => {
  it("starts loading: nothing observed, nothing failed", () => {
    expect(observationPhase(obs0<M>(), 1_000)).toBe("loading");
    expect(obs0<M>().value).toBeNull();
  });

  it("a first success turns the feed fresh and records when the reading landed", () => {
    const o = observeSuccess(obs0<M>(), { ramPercent: 50 }, 5_000, false);
    expect(o.value).toEqual({ ramPercent: 50 });
    expect(o.everOk).toBe(true);
    expect(observationPhase(o, 6_000)).toBe("fresh");
  });

  it("an UNCHANGED successful reading is still a fresh observation (the heartbeat moves)", () => {
    const o1 = observeSuccess(obs0<M>(), { ramPercent: 50 }, 5_000, false);
    // the poll deduplicates the values, but the observation itself must refresh
    const o2 = observeSuccess(o1, { ramPercent: 50 }, 20_000, true);
    expect(o2.value).toBe(o1.value); // the identical value object is kept (no re-render churn)
    expect(o2.observedAt).toBe(20_000);
    expect(observationPhase(o2, 45_000)).toBe("fresh");
  });

  it("a reading older than the 30 s contract is stale, even though values were kept", () => {
    const o = observeSuccess(obs0<M>(), { ramPercent: 50 }, 0, false);
    expect(observationPhase(o, 31_000)).toBe("stale");
    expect(o.value).toEqual({ ramPercent: 50 }); // the last good reading is still there
  });

  it("a failure keeps the last reading and counts consecutive failures", () => {
    const o1 = observeSuccess(obs0<M>(), { ramPercent: 50 }, 0, false);
    const o2 = observeFailure(o1, 1_000);
    const o3 = observeFailure(o2, 2_000);
    expect(o3.value).toBe(o1.value);
    expect(o3.failures).toBe(2);
    expect(o3.observedAt).toBe(0);
  });

  it("never-succeeded + companion feed failing too = disconnected, not merely failed", () => {
    const failed = observeFailure(obs0<M>(), 1_000);
    expect(observationPhase(failed, 2_000, false)).toBe("failed");
    expect(observationPhase(failed, 2_000, true)).toBe("disconnected");
  });

  it("recovery resets the failure counters and renews the stamp", () => {
    const o = observeFailure(observeFailure(observeSuccess(obs0<M>(), { ramPercent: 50 }, 0, false), 1_000), 2_000);
    const back = observeSuccess(o, { ramPercent: 51 }, 3_000, false);
    expect(back.failures).toBe(0);
    expect(back.failedAt).toBe(0);
    expect(observationPhase(back, 4_000)).toBe("fresh");
  });

  it("a fresh reading whose own scopes have no counters is still fresh (availability is not staleness)", () => {
    // availability ("n/a") is decided per value by the meters, never by the feed clock
    const o = observeSuccess(obs0<M>(), { ramPercent: 50 }, 1_000, false);
    expect(observationPhase(o, 2_000)).toBe("fresh");
  });
});

describe("Last-updated stamp", () => {
  it("reads just now, seconds, then minutes", () => {
    expect(lastUpdatedText(10_000, 10_000)).toBe("just now");
    expect(lastUpdatedText(10_000, 10_004)).toBe("just now");
    expect(lastUpdatedText(10_000, 45_000)).toBe("35 seconds ago");
    expect(lastUpdatedText(10_000, 130_000)).toBe("2 minutes ago");
    expect(lastUpdatedText(0, 130_000)).toBe("never");
  });
});

// -------------------------------------------------------------------------- feeds

/** The applied readings a feed collected, for asserting on the ordering rule. */
function feedLog<T>(): { feed: ObservationFeed<T>; applied: T[] } {
  const applied: T[] = [];
  const feed = new ObservationFeed<T>((v) => { applied.push(v); });
  return { feed, applied };
}

describe("ObservationFeed — one ordering rule for every source", () => {
  it("an event beats an in-flight poll: the older poll response is dropped", () => {
    const { feed, applied } = feedLog<number>();
    const poll = feed.beginRequest();
    expect(poll).not.toBeNull();
    // a newer event arrives while the poll is in flight
    feed.pushEvent(2, 1_000, false);
    expect(applied).toEqual([2]);
    // the older poll resolves late: its token no longer stands, it must not apply
    expect(feed.settleSuccess(poll!, 1, 2_000, false)).toBe(false);
    expect(applied).toEqual([2]);
  });

  it("a new send beats an old response: a forced retry supersedes the hung attempt", () => {
    const { feed, applied } = feedLog<number>();
    const first = feed.beginRequest();
    const retry = feed.beginRequest(true); // the manual retry goes out anyway
    expect(retry).not.toBeNull();
    feed.settleSuccess(retry!, 7, 1_000, false);
    expect(applied).toEqual([7]);
    // the older attempt (the hung one) lands late: dropped
    expect(feed.settleSuccess(first!, 5, 2_000, false)).toBe(false);
    expect(applied).toEqual([7]);
  });

  it("a request is bounded to one in flight: beginRequest skips while one is pending", () => {
    const { feed } = feedLog<number>();
    expect(feed.beginRequest()).not.toBeNull();
    expect(feed.beginRequest()).toBeNull(); // the interval tick is skipped
    expect(feed.beginRequest(true)).not.toBeNull(); // forced one-shots still go out
    expect(feed.inFlight).toBe(2);
  });

  it("after a timeout the token is gone: a late resolution is a no-op", () => {
    const { feed, applied } = feedLog<number>();
    const token = feed.beginRequest();
    // the caller gives up (withTimeout rejected) and settles the token as a failure
    expect(feed.settleFailure(token!, 11_000)).toBe(true);
    expect(feed.inFlight).toBe(0);
    // the underlying request resolves late: dropped, and it is not a new failure
    expect(feed.settleSuccess(token!, 3, 12_000, false)).toBe(false);
    expect(feed.settleFailure(token!, 12_000)).toBe(false);
    expect(applied).toEqual([]);
  });

  it("a superseded token is RELEASED when it settles: the feed keeps taking new polls", () => {
    const { feed, applied } = feedLog<number>();
    const poll = feed.beginRequest();
    feed.pushEvent(2, 1_000, false); // an event invalidates the in-flight poll
    expect(feed.settleSuccess(poll!, 1, 2_000, false)).toBe(false); // late: dropped
    // the dropped token must not leak into `live`, or every future poll is skipped
    expect(feed.inFlight).toBe(0);
    const c = feed.beginRequest(); // polls resume
    expect(c).not.toBeNull();
    feed.settleSuccess(c!, 5, 2_500, false); // and land normally
    expect(feed.inFlight).toBe(0);
    // same for a superseded FAILURE (a second forced read timing out out of order)
    const a = feed.beginRequest(true);
    const b = feed.beginRequest(true);
    feed.settleSuccess(b!, 9, 3_000, false);
    expect(feed.settleFailure(a!, 4_000)).toBe(false);
    expect(feed.inFlight).toBe(0);
    expect(applied).toEqual([2, 5, 9]);
  });

  it("a settled success keeps its identity and refreshes the heartbeat via unchanged", () => {
    let cur = initialObservation<number>();
    const feed = new ObservationFeed<number>((v, at, unchanged) => {
      cur = observeSuccess(cur, v, at, unchanged);
    });
    const t = feed.beginRequest();
    feed.settleSuccess(t!, 42, 1_000, true);
    expect(cur.value).toBe(42);
    expect(cur.observedAt).toBe(1_000);
    expect(cur.everOk).toBe(true);
    // a second, unchanged reading: same value, NEW observation time (the heartbeat)
    const t2 = feed.beginRequest();
    feed.settleSuccess(t2!, 42, 4_000, true);
    expect(cur.value).toBe(42);
    expect(cur.observedAt).toBe(4_000);
  });
});

describe("withTimeout — a bounded request lifecycle", () => {
  it("passes the underlying promise through when it settles in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1_000, "thing")).resolves.toBe("ok");
  });

  it("rejects with a TimeoutError when the request hangs, and does not double-fire", async () => {
    vi.useFakeTimers();
    let late: (v: string) => void = () => {};
    const hung = new Promise<string>((res) => { late = res; });
    const p = withTimeout(hung, 1_000, "The reading");
    const verdict = p.then(() => "resolved", (e) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    const err = await verdict as TimeoutError;
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toContain("timed out");
    // the underlying promise keeps running (the bridge cannot cancel): resolving it
    // late must not change the settled outcome nor throw an unhandled rejection
    late("late");
    await Promise.resolve();
    vi.useRealTimers();
  });
});

describe("phaseView — the clock-driven watchdog view", () => {
  it("a fresh observation publishes no stamp; expiry and the stamp come from the clock", () => {
    const obs: Observation<number> = { value: 7, observedAt: 10_000, failedAt: 0, failures: 0, everOk: true };
    const fresh = phaseView(obs, 20_000);
    expect(fresh.phase).toBe("fresh");
    expect(fresh.stamp).toBe("");
    const stale = phaseView(obs, 50_000);
    expect(stale.phase).toBe("stale");
    expect(stale.at).toBe(10_000);
    expect(stale.stamp).toBe("40 seconds ago");
  });

  it("a second that changes no visible text produces an identical view (the publisher skips it)", () => {
    const obs: Observation<number> = { value: 7, observedAt: 10_000, failedAt: 0, failures: 0, everOk: true };
    const a = phaseView(obs, 50_000);
    const b = phaseView(obs, 50_400); // rounds to the same rendered second
    expect(phaseViewSame(a, b)).toBe(true);
    const c = phaseView(obs, 50_500); // rounds up to "41 seconds ago": a visible change
    expect(phaseViewSame(a, c)).toBe(false);
  });
});
