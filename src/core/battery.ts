/**
 * The battery as Windows reports it, finer than the percentage: remaining capacity in mWh and the discharge rate in mW
 * (WMI, root\wmi: BatteryStatus and BatteryFullChargedCapacity). On the mains the rate is 0 and says nothing about what the PC draws,
 * so a reading taken while plugged in is marked as such and never turned into a figure.
 */
export interface BatteryReading {
  /** The battery answered. False on a PC without one, or when Windows does not expose the class. */
  present: boolean;
  /** Plugged in: the discharge rate is not the PC's draw. */
  onMains: boolean;
  discharging: boolean;
  remainingMWh: number;
  fullMWh: number;
  /** Power drawn from the battery, in mW (0 on the mains). */
  dischargeMW: number;
  voltageMV: number;
  at: number;
}

/** The PowerShell that prints one JSON line with what is needed. */
export const BATTERY_SCRIPT =
  "$s = Get-CimInstance -Namespace root\\wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue | Select-Object -First 1; " +
  "$f = Get-CimInstance -Namespace root\\wmi -ClassName BatteryFullChargedCapacity -ErrorAction SilentlyContinue | Select-Object -First 1; " +
  "if ($s) { [pscustomobject]@{ remaining = $s.RemainingCapacity; full = $f.FullChargedCapacity; rate = $s.DischargeRate; voltage = $s.Voltage; online = $s.PowerOnline; discharging = $s.Discharging } | ConvertTo-Json -Compress } else { '{}' }";

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** One reading from the output of BATTERY_SCRIPT. Anything unreadable is "no battery". */
export function parseBattery(out: string, at = Date.now()): BatteryReading {
  const none: BatteryReading = { present: false, onMains: false, discharging: false, remainingMWh: 0, fullMWh: 0, dischargeMW: 0, voltageMV: 0, at };
  const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("{"));
  if (!line) return none;
  let o: Record<string, unknown>;
  try { o = JSON.parse(line); } catch { return none; }
  if (typeof o.remaining !== "number") return none;
  const onMains = o.online === true;
  return { present: true, onMains, discharging: o.discharging === true && !onMains, remainingMWh: n(o.remaining), fullMWh: n(o.full), dischargeMW: onMains ? 0 : n(o.rate), voltageMV: n(o.voltage), at };
}

/** Charge in percent to one decimal, from the real full capacity. */
export const batteryPercent = (r: BatteryReading) => (r.fullMWh > 0 ? Math.round((r.remainingMWh / r.fullMWh) * 1000) / 10 : null);

/**
 * A reading that came from the host's native battery IOCTLs (the `powerReading` host
 * capability): the same fields `parseBattery` produces, with `null` where Windows marks
 * the value unknown. Converted to the shared `BatteryReading` shape with the same
 * defaults `parseBattery` applies (an unreadable figure is 0 there, a missing battery
 * is `present: false`) so the consumers above keep their exact semantics.
 */
export function batteryFromHost(o: Record<string, unknown> | null | undefined, at = Date.now()): BatteryReading {
  const none: BatteryReading = { present: false, onMains: false, discharging: false, remainingMWh: 0, fullMWh: 0, dischargeMW: 0, voltageMV: 0, at };
  if (!o || typeof o !== "object" || o.present !== true) return none;
  const onMains = o.onMains === true;
  return { present: true, onMains, discharging: o.discharging === true && !onMains, remainingMWh: n(o.remainingMWh), fullMWh: n(o.fullMWh), dischargeMW: onMains ? 0 : n(o.dischargeMW), voltageMV: n(o.voltageMV), at };
}

/**
 * The power reading cached for `ttlMs` (30 s in the request selection): a battery does
 * not change between two requests, and every PowerShell-free read still costs an
 * IOCTL round trip. A failed read (null) is cached too, like today's failed read.
 */
export function createCachedPowerReader(read: () => Promise<BatteryReading | null>, opts: { ttlMs?: number; now?: () => number } = {}) {
  const ttl = opts.ttlMs ?? 30_000;
  const now = opts.now ?? Date.now;
  let cache: { at: number; reading: BatteryReading | null } | null = null;
  return async (): Promise<BatteryReading | null> => {
    if (cache && now() - cache.at < ttl) return cache.reading;
    const reading = await read().catch(() => null);
    cache = { at: now(), reading };
    return reading;
  };
}

/**
 * The battery reader that prefers the host's native answer and holds its decision for
 * the whole session. A "no battery" from the host is only believed when the fallback
 * confirms it: the host's enumeration can fail while Windows still sees a battery, and
 * a wrongly trusted "no battery" would empty the battery panel, the benchmark's power
 * line and the on-battery compute choice. So: a real host reading pins the host; a
 * fallback that finds a battery pins the fallback for the session (logged, once); a
 * host refusal AND an empty fallback decide nothing and ask again next time.
 */
export function createHostFirstBatteryReader(opts: {
  /** The host's converted reading, or null when it refused or errored. */
  host: () => Promise<BatteryReading | null>;
  /** The PowerShell fallback's reading (present:false when it sees none). */
  fallback: () => Promise<BatteryReading | null>;
  log?: (line: string) => void;
  noteSource?: (source: "host" | "fallback") => void;
}): () => Promise<BatteryReading | null> {
  const log = opts.log ?? (() => {});
  const noteSource = opts.noteSource ?? (() => {});
  let source: "host" | "fallback" | null = null;
  return async (): Promise<BatteryReading | null> => {
    if (source === "fallback") {
      const r = await opts.fallback();
      noteSource("fallback");
      return r;
    }
    const fromHost = await opts.host();
    if (source === "host") {
      noteSource("host");
      return fromHost;
    }
    if (fromHost?.present) {
      source = "host";
      noteSource("host");
      return fromHost;
    }
    // the host refused, errored, or answers "no battery": the fallback decides once
    const fromFallback = await opts.fallback();
    if (fromFallback?.present) {
      if (fromHost && fromHost.present === false) log("[readings] power: host says no battery, fallback found one");
      source = "fallback";
      noteSource("fallback");
      return fromFallback;
    }
    if (fromHost) {
      source = "host"; // a real no-battery answer the fallback confirms
      noteSource("host");
      return fromHost;
    }
    return fromFallback; // both sides unusable: no decision, ask again next time
  };
}

export interface BatteryRun {
  seconds: number;
  /** Average draw over the run, in W. */
  avgWatts: number;
  peakWatts: number;
  /** Energy used, in mWh: from the draw integrated over time, which moves more finely than the remaining capacity. */
  usedMWh: number;
  /** The drop of the remaining capacity, as a check on the figure above. */
  capacityDropMWh: number;
  samples: number;
  /** Why the figures cannot be trusted (a run too short, a capacity that rose, an energy that disagrees with the drop); empty when they can. */
  problem: string;
}

const MIN_SECONDS = 20;
/** Below this the capacity (which moves in steps) cannot check the integrated energy. */
const CHECKABLE_MWH = 150;

/** What a run drew, from its readings in order. Null when the PC was on the mains at any point or there are fewer than two readings. */
export function summarizeBattery(readings: BatteryReading[]): BatteryRun | null {
  if (readings.length < 2 || readings.some((r) => !r.present || r.onMains)) return null;
  let usedMWh = 0, peak = 0;
  for (let i = 1; i < readings.length; i++) {
    const dt = (readings[i].at - readings[i - 1].at) / 3_600_000;
    usedMWh += ((readings[i].dischargeMW + readings[i - 1].dischargeMW) / 2) * dt;
    peak = Math.max(peak, readings[i].dischargeMW);
  }
  const seconds = (readings[readings.length - 1].at - readings[0].at) / 1000;
  if (seconds <= 0) return null;
  const capacityDropMWh = readings[0].remainingMWh - readings[readings.length - 1].remainingMWh;
  let problem = "";
  if (seconds < MIN_SECONDS) problem = `Run too short (${Math.round(seconds)} s): at least ${MIN_SECONDS} s are needed.`;
  else if (usedMWh <= 0) problem = "The battery reported no draw.";
  else if (capacityDropMWh < 0) problem = "The remaining capacity rose during the run: the PC was charging or the reading is wrong.";
  else if (usedMWh >= CHECKABLE_MWH && (capacityDropMWh < usedMWh * 0.5 || capacityDropMWh > usedMWh * 2)) problem = "The draw and the drop of the capacity disagree by more than a factor of two.";
  return {
    seconds,
    avgWatts: Math.round(((usedMWh / (seconds / 3600)) / 1000) * 100) / 100,
    peakWatts: Math.round((peak / 1000) * 100) / 100,
    usedMWh: Math.round(usedMWh * 10) / 10,
    capacityDropMWh,
    samples: readings.length,
    problem,
  };
}

/** Energy per generated token in mWh, taking off the draw of the PC at rest so only the generation is counted. */
export function mWhPerToken(run: BatteryRun, restWatts: number, tokens: number): number | null {
  if (tokens <= 0 || run.problem) return null;
  const extra = Math.max(0, run.avgWatts - restWatts) * 1000 * (run.seconds / 3600);
  return Math.round((extra / tokens) * 1000) / 1000;
}

export interface Energy {
  restWatts: number;
  genWatts: number;
  /** Energy of one generated token, the PC's rest draw taken off. Null when the readings cannot say. */
  mWhPerToken: number | null;
  problem: string;
}

export function integratedWatts(rs: BatteryReading[]): number {
  if (rs.length === 0) return 0;
  if (rs.length === 1) return rs[0].dischargeMW / 1000;
  let usedMWh = 0;
  let totalHours = 0;
  for (let i = 1; i < rs.length; i++) {
    const dt = (rs[i].at - rs[i - 1].at) / 3_600_000;
    if (dt > 0) {
      usedMWh += ((rs[i].dischargeMW + rs[i - 1].dischargeMW) / 2) * dt;
      totalHours += dt;
    }
  }
  if (totalHours > 0) {
    return (usedMWh / totalHours) / 1000;
  }
  return rs.reduce((s, r) => s + r.dischargeMW, 0) / rs.length / 1000;
}

/**
 * The energy of one token from two series of readings: the PC at rest with the model loaded, and the PC while the model writes.
 * Computes time-integrated power draw via trapezoidal integration over sample timestamps.
 */
export function energyPerToken(rest: BatteryReading[], gen: BatteryReading[], tokPerSec: number | null, opts: { minDurationSec?: number } = {}): Energy | null {
  if ([...rest, ...gen].some((r) => !r.present || r.onMains)) return null;
  if (!rest.length || !gen.length) return null;
  const restWatts = Math.round(integratedWatts(rest) * 100) / 100;
  const genWatts = Math.round(integratedWatts(gen) * 100) / 100;
  let problem = "";
  const minDuration = opts.minDurationSec ?? 0;
  const genDuration = gen.length > 1 ? (gen[gen.length - 1].at - gen[0].at) / 1000 : 0;
  if (rest.length < 2 || gen.length < 3) problem = "Too few readings to say.";
  else if (minDuration > 0 && genDuration < minDuration) problem = `Run too short (${Math.round(genDuration)} s): at least ${minDuration} s needed.`;
  else if (!tokPerSec) problem = "The writing speed is not known.";
  else if (genWatts <= restWatts) problem = "The draw while writing was not above the draw at rest.";
  return { restWatts, genWatts, mWhPerToken: problem || !tokPerSec ? null : Math.round(((genWatts - restWatts) / tokPerSec / 3.6) * 1000) / 1000, problem };
}
