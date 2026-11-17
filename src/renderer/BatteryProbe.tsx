import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { batteryPercent, summarizeBattery, type BatteryReading } from "../core/battery";
import { useDocumentVisible } from "./useDocumentVisible";

/**
 * Developer settings: the battery as Windows reports it, in watts and mWh. Start a run, generate with a model, stop: the draw is integrated
 * over the run. On the mains nothing is measured, and a run that cannot be trusted (too short, capacity that rose, energy that disagrees with
 * the drop) is shown as a problem, never as a figure.
 */
export function BatteryProbe() {
  const [now, setNow] = useState<BatteryReading | null>(null);
  const [recording, setRecording] = useState(false);
  const [done, setDone] = useState<ReturnType<typeof summarizeBattery> | "none">(null);
  const readings = useRef<BatteryReading[]>([]);
  const recordingRef = useRef(false);
  recordingRef.current = recording;
  // Each tick asks the host for one battery reading (the class driver's IOCTLs; the
  // host answers in milliseconds — the PowerShell spawn this panel used to cost every
  // 1.5 s is gone). It only feeds a dev-only readout, so it must not run against a
  // hidden window.
  const docVisible = useDocumentVisible();
  useEffect(() => {
    if (!docVisible) return;
    let alive = true;
    const tick = async () => {
      const r = await api().batteryRead().catch(() => null);
      if (!alive || !r) return;
      setNow(r);
      if (recordingRef.current) readings.current.push(r);
    };
    void tick();
    const t = setInterval(() => void tick(), 1500);
    return () => { alive = false; clearInterval(t); };
  }, [docVisible]);
  const start = () => { readings.current = now ? [now] : []; setDone(null); setRecording(true); };
  const stop = () => { setRecording(false); setDone(summarizeBattery(readings.current) ?? "none"); };
  const pct = now ? batteryPercent(now) : null;
  return (
    <div className="stack">
      {!now ? <p className="muted">Reading the battery…</p>
        : !now.present ? <p className="warn">Windows does not report a battery on this PC.</p>
        : <>
          <p>{pct !== null ? `${pct} %` : "–"} · {now.remainingMWh} / {now.fullMWh} mWh · {now.onMains ? <span className="warn">plugged in: unplug the charger to measure</span> : <b>{(now.dischargeMW / 1000).toFixed(1)} W</b>}</p>
          <div className="row">
            {!recording ? <button onClick={start} disabled={now.onMains}>Start a run</button> : <button onClick={stop}>Stop the run</button>}
            <span className="muted small">{recording ? `${readings.current.length} readings. Generate with a model, then stop (at least 20 s).` : "Start, generate with a model, stop."}</span>
          </div>
        </>}
      {done === "none" && <p className="warn">No result: the PC was plugged in during the run or there were too few readings.</p>}
      {done && done !== "none" && (done.problem
        ? <p className="warn">Not trusted: {done.problem}</p>
        : <p>{done.avgWatts} W on average (peak {done.peakWatts} W) over {Math.round(done.seconds)} s · {done.usedMWh} mWh used, capacity down {done.capacityDropMWh} mWh</p>)}
    </div>
  );
}
