use std::fs;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::memory_estimator::{get_available_ram_bytes, is_qairt_model};
use crate::paths::{get_config_dir, get_hardware_path};
use crate::power::resolve_effective_power_mode;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkResult {
    #[serde(rename = "modelRef")]
    pub model_ref: String,
    #[serde(rename = "compute")]
    pub compute: String,
    #[serde(rename = "powerMode")]
    pub power_mode: String,
    #[serde(rename = "ttftMs")]
    /// Milliseconds to the first token, when the run's telemetry gave a real one.
    /// A run without a measurable first token stores null — never 0, which reads as
    /// "the first token arrived instantly", a fact no run can claim.
    pub ttft_ms: Option<f64>,
    #[serde(rename = "decodeTokPerSec")]
    pub decode_tok_per_sec: f64,
    #[serde(rename = "prefillTokPerSec")]
    pub prefill_tok_per_sec: Option<f64>,
    #[serde(rename = "loadTimeMs")]
    pub load_time_ms: u64,
    #[serde(rename = "tokensGenerated")]
    pub tokens_generated: u32,
    #[serde(rename = "ramUsedMB")]
    pub ram_used_mb: f64,
    /** What ramUsedMB measures: system-wide memory in use, NOT the shell's and NOT the model's alone. */
    #[serde(rename = "ramScope")]
    pub ram_scope: String,
    /** False: load_time_ms is total duration minus an ESTIMATED decode time, not an observed load event. */
    #[serde(rename = "loadTimeMeasured")]
    pub load_time_measured: bool,
    /** The output budget actually passed to `--max-tokens` (B01: `-n` is --ngl, not a token limit). */
    #[serde(rename = "maxTokens")]
    pub max_tokens: i32,
    /** The layer-offload policy actually passed to `--ngl` (-1 = all). */
    #[serde(rename = "ngl")]
    pub ngl: i32,
    #[serde(rename = "verifiedNpu")]
    pub verified_npu: bool,
    #[serde(rename = "outputSnippet")]
    pub output_snippet: String,
    /// Additive so results stored by older builds (hardware.json's lastBenchmark) still deserialize.
    #[serde(default, rename = "childPrivateMemMB")]
    pub child_private_mem_mb: Option<f64>,
    #[serde(default, rename = "firstOutputMs")]
    pub first_output_ms: Option<u64>,
}

static BENCH_CANCEL: AtomicU64 = AtomicU64::new(0);

/// Ask the running benchmark (if any) to stop: the child is killed at the next poll.
pub fn cancel_benchmark() {
    BENCH_CANCEL.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn benchmark_generation() -> u64 {
    BENCH_CANCEL.load(Ordering::Relaxed)
}

pub fn load_hardware_config() -> Value {
    let path = get_hardware_path();
    if path.exists()
        && let Ok(content) = fs::read_to_string(&path)
            && let Ok(val) = serde_json::from_str(&content) {
                return val;
            }

    serde_json::json!({
        "calibratedProfiles": {},
        "lastBenchmark": null
    })
}

pub fn save_hardware_config(patch: Value) -> Result<Value, String> {
    let mut current = load_hardware_config();
    if let (Some(cur_obj), Some(patch_obj)) = (current.as_object_mut(), patch.as_object()) {
        for (k, v) in patch_obj {
            cur_obj.insert(k.clone(), v.clone());
        }
    }

    let _ = fs::create_dir_all(get_config_dir());
    let path = get_hardware_path();
    let serialized = serde_json::to_string_pretty(&current)
        .map_err(|e| format!("Failed to serialize hardware config: {}", e))?;

    fs::write(&path, serialized)
        .map_err(|e| format!("Failed to write hardware config to {:?}: {}", path, e))?;

    crate::paths::append_log("mkmn", &format!("Hardware config saved to {:?}", path));
    Ok(current)
}

pub fn parse_infer_telemetry(raw_output: &str) -> (Option<f64>, Option<u32>, Option<f64>) {
    // Look for pattern: "— 64.8 tok/s • 9 tok • 0.0 s first token —"
    for line in raw_output.lines() {
        if line.contains("tok/s") && line.contains("first token") {
            let mut speed: Option<f64> = None;
            let mut tok_count: Option<u32> = None;
            let mut ttft: Option<f64> = None;

            // Split by bullet or dot
            let parts: Vec<&str> = line.split(['•', '|', '—', '-']).collect();
            for part in parts {
                let trimmed = part.trim();
                if trimmed.contains("tok/s") {
                    if let Some(num_str) = trimmed.split_whitespace().next()
                        && let Ok(val) = num_str.parse::<f64>() {
                            speed = Some(val);
                        }
                } else if trimmed.ends_with("tok") {
                    if let Some(num_str) = trimmed.split_whitespace().next()
                        && let Ok(val) = num_str.parse::<u32>() {
                            tok_count = Some(val);
                        }
                } else if trimmed.contains("s first token")
                    && let Some(num_str) = trimmed.split_whitespace().next()
                        && let Ok(val) = num_str.parse::<f64>() {
                            // "0.0 s first token" is what the runtime prints when it did
                            // not measure the first token (the real Qwen3-0.6B run). No
                            // first token arrives in 0 s: an impossible figure is NOT a
                            // measurement — report it as absent, never as 0 ms.
                            ttft = if val > 0.0 { Some(val) } else { None };
                        }
            }

            if speed.is_some() || tok_count.is_some() {
                return (speed, tok_count, ttft);
            }
        }
    }
    (None, None, None)
}

/**
 * The command contract for `geniex infer`, in one place so a CLI/C API shorthand
 * difference cannot silently change what is measured:
 *  - the output budget is `--max-tokens` (`-n` is `--ngl`, layer offloading);
 *  - the offload policy is explicit (`--ngl`);
 *  - compute and window are sent for GGUF only: a QAIRT bundle is a compiled NPU
 *    artifact and takes neither flag.
 */
// one argument per thing the command line is made of; a struct would only rename them
#[allow(clippy::too_many_arguments)]
pub fn build_infer_args(
    model_ref: &str,
    prompt: &str,
    max_tokens: i32,
    ngl: i32,
    think: bool,
    power_mode: &str,
    compute: Option<&str>,
    nctx: Option<u32>,
    qairt_lib: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "infer".to_string(),
        model_ref.to_string(),
        "--prompt".to_string(),
        prompt.to_string(),
        "--max-tokens".to_string(),
        max_tokens.to_string(),
        "--ngl".to_string(),
        ngl.to_string(),
        format!("--think={}", think),
        "--power-mode".to_string(),
        power_mode.to_string(),
    ];
    if let Some(c) = compute {
        args.push("--compute".to_string());
        args.push(c.to_string());
        if let Some(ctx) = nctx {
            args.push("--nctx".to_string());
            args.push(ctx.to_string());
        }
    }
    // the same QAIRT runtime the chat server runs a native model against (qairt_runtime.rs):
    // without it the benchmark's DSP loaded the driver's older skel and the bundle failed
    if let Some(lib) = qairt_lib.map(str::trim).filter(|l| !l.is_empty()) {
        args.push("--qairt-lib".to_string());
        args.push(lib.to_string());
    }
    args
}

pub fn run_model_benchmark(
    model_ref: &str,
    compute: Option<&str>,
    power_mode: Option<&str>,
    nctx: Option<u32>,
    generation: u64,
) -> Result<BenchmarkResult, String> {
    if generation != benchmark_generation() { return Err("Benchmark was cancelled.".into()); }
    // the same minimum-version gate as every server start: no benchmark runs an older GenieX
    let geniex_path = crate::capabilities::require_geniex(None)?;

    let effective_compute = compute.unwrap_or("npu");
    let eff_power_mode = resolve_effective_power_mode(power_mode.unwrap_or("burst"));
    let is_qairt = is_qairt_model(model_ref);

    // A QAIRT bundle is a precompiled Hexagon artifact: `--compute` is not sent for it,
    // and a caller that asks for CPU/GPU/hybrid is refused instead of being answered
    // with a run that silently did something else than what was recorded.
    if is_qairt {
        let requested = effective_compute.to_ascii_lowercase();
        if requested != "npu" {
            return Err(format!(
                "QAIRT bundles run on the Hexagon NPU only: '{}' was requested, but this compiled artifact has no CPU/GPU/hybrid path. Use a GGUF build of the model for the other compute targets.",
                effective_compute
            ));
        }
    }
    let effective_compute = effective_compute.to_ascii_lowercase();

    // Same cache as chat: NO --data-dir override. Pointing the benchmark at the
    // app-local GenieX directory started its child with an EMPTY model set — a
    // model installed for chat appeared missing to the benchmark, and vice versa.
    // The supervisor deliberately serves GenieX's own default cache (~/.cache/
    // geniex); the benchmark's child must read the same one.

    // CLI contract, verified against the installed GenieX 0.10.0 help
    // (from `geniex infer --help`):
    //   `-n/--ngl`  = number of layers OFFLOADED (default -1 = all) — NOT an output limit;
    //   `--max-tokens` = the output-token budget (default 2048);
    //   `-c/--compute` = cpu | gpu | npu | hybrid | an explicit device list.
    // The old code passed the intended token budget into `-n`, which silently reconfigured
    // layer offloading instead of limiting generation, and never bounded the output.
    // Offload policy is now explicit (all layers, which is what "--compute npu" means),
    // the output budget is the real flag, and both are recorded in the result.
    let qairt_lib = {
        let settings = crate::settings::load_settings();
        let configured = crate::settings::checked_string(&settings, "qairtLib");
        let flag = crate::capabilities::probe(&geniex_path).supports("--qairt-lib");
        let env = std::env::var("GENIEX_QAIRT_LIB").ok();
        crate::qairt_runtime::effective_qairt_lib(Some(&configured), env.as_deref(), is_qairt, flag,
            || crate::qairt_runtime::pinned_runtime(&geniex_path))
            .filter(|_| is_qairt)
    };
    let max_tokens: i32 = 24;
    let ngl: i32 = -1;
    let args = build_infer_args(
        model_ref,
        "Calculate 25 * 4 and explain in one sentence.",
        max_tokens,
        ngl,
        false,
        eff_power_mode,
        if is_qairt { None } else { Some(&effective_compute) },
        if is_qairt { None } else { nctx },
        qairt_lib.as_deref(),
    );

    crate::paths::append_log("mkmn", &format!("[benchmark] Spawning: {:?} {:?}", geniex_path, args));

    // Enforce Tier 2 Inference-Critical QoS: ABOVE_NORMAL_PRIORITY_CLASS, Strictly Unthrottled, Sleep Inhibited
    let _infer_guard = crate::qos::InferenceQoSGuard::new();
    let start_time = Instant::now();

    if generation != benchmark_generation() { return Err("Benchmark was cancelled.".into()); }
    let child = Command::new(&geniex_path)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x00008000 | 0x08000000) // ABOVE_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW
        .spawn();

    // Measured NPU verification: sample the NPU's PDH counters (compute-only adapter,
    // see monitor.rs::PdhGpuSampler) in a thread while the child runs, attributed to
    // the child's own PID. geniex's output names HTP on some models and machines and
    // not on others, so a string match both missed real NPU runs and could be fooled
    // by a line that only mentions it.
    let wants_npu = effective_compute == "npu" || effective_compute == "hybrid";
    let sampling_done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let pid_for_sampler = child.as_ref().ok().map(|c| c.id());
    let sampler = if wants_npu {
        let done = sampling_done.clone();
        Some(std::thread::spawn(move || {
            let mut peak = 0.0f64;
            let deadline = Instant::now() + Duration::from_secs(600);
            if let Some(ref mut s) = crate::monitor::PdhGpuSampler::new() {
                while !done.load(std::sync::atomic::Ordering::Relaxed) && Instant::now() < deadline {
                    // attribute to the benchmark's own child only: another process's
                    // NPU work must not verify this run
                    if let Some(v) = pid_for_sampler.and_then(|p| s.npu_for_pid(p)) {
                        peak = peak.max(v);
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
            peak
        }))
    } else {
        None
    };

    // B07: the child process's OWN memory, sampled while it runs. The `ramUsedMB`
    // figure is SYSTEM-WIDE memory in use (every process included) and is labeled as
    // such; this one is attributed to the child via its private commit (PrivateUsage,
    // the same quantity monitor.rs reports per process). None when the child's memory
    // could not be read (it exited before the first sample, or the handle was refused).
    let mem_done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mem_sampler = pid_for_sampler.map(|pid| {
        let done = mem_done.clone();
        std::thread::spawn(move || -> f64 {
            use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
            use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX};
            use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
            let mut peak_mb = 0.0f64;
            unsafe {
                let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if !h.is_null() && h != INVALID_HANDLE_VALUE {
                    loop {
                        if done.load(std::sync::atomic::Ordering::Relaxed) {
                            break;
                        }
                        let mut pmc: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
                        pmc.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
                        if K32GetProcessMemoryInfo(h, &mut pmc as *mut _ as *mut _, pmc.cb) != 0 {
                            peak_mb = peak_mb.max(pmc.PrivateUsage as f64 / (1024.0 * 1024.0));
                        } else {
                            // the child is gone: its memory story ends here
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    CloseHandle(h);
                }
            }
            (peak_mb * 10.0).round() / 10.0
        })
    });

    // A hung `geniex infer` used to block this call forever (and the UI with it): the
    // child now has a deadline, and the UI can cancel the run. The pipes are drained
    // by threads so a chatty child cannot deadlock on a full pipe while we poll.
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            sampling_done.store(true, std::sync::atomic::Ordering::Relaxed);
            return Err(format!("Failed to execute benchmark: {}", e));
        }
    };
    use std::io::Read;
    // B07: the observed spawn → first stdout byte time (a REAL event, unlike the
    // estimated loadTimeMs). The first byte is read alone so its timestamp is taken
    // when it arrives, not when the pipe is drained.
    let first_out_ms = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let fo = first_out_ms.clone();
    let mut stdout_pipe = child.stdout.take().expect("stdout was piped");
    let mut stderr_pipe = child.stderr.take().expect("stderr was piped");
    let out_reader = std::thread::spawn(move || {
        let mut buf: Vec<u8> = Vec::new();
        let mut first = [0u8; 1];
        if let Ok(n) = stdout_pipe.read(&mut first)
            && n > 0 {
                fo.store(start_time.elapsed().as_millis() as u64, std::sync::atomic::Ordering::Relaxed);
                buf.push(first[0]);
                let _ = stdout_pipe.read_to_end(&mut buf);
            }
        String::from_utf8_lossy(&buf).to_string()
    });
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr_pipe.read_to_string(&mut s);
        s
    });

    const BENCH_DEADLINE_SECS: u64 = 900; // 15 minutes for one bounded 24-token answer
    let deadline = Instant::now() + Duration::from_secs(BENCH_DEADLINE_SECS);
    let mut timed_out = false;
    let mut cancelled = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {
                if generation != benchmark_generation() {
                    cancelled = true;
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                if Instant::now() > deadline {
                    timed_out = true;
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                sampling_done.store(true, std::sync::atomic::Ordering::Relaxed);
                mem_done.store(true, std::sync::atomic::Ordering::Relaxed);
                return Err(format!("Failed to wait for the benchmark process: {}", e));
            }
        }
    };

    let duration = start_time.elapsed();
    let stdout_str = out_reader.join().unwrap_or_default();
    let stderr_str = err_reader.join().unwrap_or_default();
    let combined = format!("{}\n{}", stdout_str, stderr_str);
    let out_status = status;

    // The child has exited: the sampling window is over, whatever happens next.
    let mut measured_npu_peak = 0.0f64;
    if let Some(handle) = sampler {
        sampling_done.store(true, std::sync::atomic::Ordering::Relaxed);
        measured_npu_peak = handle.join().unwrap_or(0.0);
    }
    if measured_npu_peak >= 2.0 {
        crate::paths::append_log("mkmn", &format!("[benchmark] NPU execution measured: the benchmark process used the NPU (PDH utilization peaked at {:.0}%).", measured_npu_peak));
    }

    // The memory sampler stops with the child; its peak is the child's own footprint.
    let mut child_private_mem_mb: Option<f64> = None;
    if let Some(handle) = mem_sampler {
        mem_done.store(true, std::sync::atomic::Ordering::Relaxed);
        let peak = handle.join().unwrap_or(0.0);
        if peak > 0.0 {
            child_private_mem_mb = Some(peak);
        }
    }
    let observed_first_ms = first_out_ms.load(std::sync::atomic::Ordering::Relaxed);
    let first_output_ms: Option<u64> = if observed_first_ms > 0 { Some(observed_first_ms) } else { None };

    if cancelled {
        return Err("Benchmark cancelled.".to_string());
    }
    if timed_out {
        return Err(format!(
            "Benchmark stopped: geniex did not finish within {} s and was killed.",
            BENCH_DEADLINE_SECS
        ));
    }

    // A failed run is a failed benchmark: never salvage numbers from it. The child must
    // have exited successfully AND have produced parseable telemetry, or the caller gets
    // an error instead of plausible-looking values.
    if !out_status.map(|s| s.success()).unwrap_or(false) {
        let tail: String = stderr_str
            .lines().rfind(|l| !l.trim().is_empty())
            .unwrap_or("")
            .to_string();
        return Err(format!(
            "Benchmark failed: geniex exited with status {}{}",
            out_status.map(|s| s.to_string()).unwrap_or_else(|| "unknown".to_string()),
            if tail.is_empty() { String::new() } else { format!(": {}", tail) }
        ));
    }

    let (speed_opt, tok_count_opt, ttft_opt) = parse_infer_telemetry(&combined);
    // The first-token figure is OPTIONAL: a run without one (the telemetry says
    // "0.0 s first token", or no first-token line at all) still measured its decode
    // speed honestly — refusing the whole benchmark would throw away that speed.
    let (speed, tokens, ttft_seconds) = match (speed_opt, tok_count_opt, ttft_opt) {
        (Some(s), Some(t), ttf) if s > 0.0 && t > 0 => (s, t, ttf),
        _ => {
            return Err(
                "Benchmark produced no measurable telemetry (no tok/s / token count / first-token line in geniex output); refusing to report estimated numbers.".to_string(),
            )
        }
    };
    let decode_speed = speed;
    let ttft_ms = ttft_seconds.map(|s| (s * 1000.0).round());

    // verifiedNpu is only ever claimed from evidence: PDH utilization measured while
    // the child ran, or the child's own AFFIRMATIVE offload/device lines (B06: a line
    // that only MENTIONS a device — a backend banner like "ggml-hex: HTP0 started", a
    // probe, a failure message — does not certify that the model ran on it).
    let log_evidence = affirmative_npu_log(&combined.lines().collect::<Vec<&str>>());
    let verified_npu = measured_npu_peak >= 2.0 || log_evidence;

    // Estimate host RAM footprint: this is SYSTEM-WIDE memory in use (total minus
    // available), every process included — it is labeled as such in the result, and it
    // is not the model's footprint.
    let (avail, total) = get_available_ram_bytes();
    let used_bytes = total.saturating_sub(avail);
    let ram_used_mb = (used_bytes as f64 / (1024.0 * 1024.0) * 10.0).round() / 10.0;

    let result = BenchmarkResult {
        model_ref: model_ref.to_string(),
        compute: effective_compute.to_string(),
        power_mode: eff_power_mode.to_string(),
        ttft_ms,
        decode_tok_per_sec: decode_speed,
        // Prefill throughput is NOT measured by geniex infer output: report it as
        // unavailable (None) rather than a derived guess.
        prefill_tok_per_sec: None,
        // Duration minus an ESTIMATED decode time: a readiness proxy, labeled as one
        // (loadTimeMeasured: false), not an observed model-load event.
        load_time_ms: (duration.as_millis() as u64).saturating_sub((tokens as u64 * 1000) / (decode_speed.max(1.0) as u64)),
        tokens_generated: tokens,
        ram_used_mb,
        ram_scope: "system-wide-in-use".to_string(),
        load_time_measured: false,
        max_tokens,
        ngl,
        verified_npu,
        output_snippet: stdout_str.trim().lines().last().unwrap_or("").to_string(),
        child_private_mem_mb,
        first_output_ms,
    };

    // Persist the measurement in hardware.json. This is a LAST MEASUREMENT, not a
    // selected optimum: no comparison ran, and testing CPU last used to overwrite a
    // faster NPU record under an "optimal" name. Measurements of every configuration
    // are kept ("runs"), so a future selection can compare them on evidence.
    // (Every failure path above returns Err BEFORE this point: a failed or cancelled
    // benchmark never touches hardware.json, so existing measurements survive it.)
    let mut config = load_hardware_config();
    record_bench_run(&mut config, &result, max_tokens, ngl, nctx);
    let _ = save_hardware_config(config);

    Ok(result)
}

/// THE profile writer: one measured run of a model, keyed by the exact build it ran
/// (`calibratedProfiles.<model_ref>.runs["<compute>|<powerMode>"]`, every configuration's
/// measurement kept), plus the convenience copy of the latest. The single-model benchmark
/// and the benchmark suite both write through it, so the Models list reads one shape.
pub(crate) fn record_run(config: &mut Value, model_ref: &str, run: Value) {
    let compute = run["compute"].as_str().unwrap_or("").to_string();
    let power = run["powerMode"].as_str().unwrap_or("").to_string();
    if let Some(obj) = config.as_object_mut() {
        let profiles = obj.entry("calibratedProfiles").or_insert_with(|| serde_json::json!({}));
        if let Some(prof_map) = profiles.as_object_mut() {
            let entry = prof_map.entry(model_ref.to_string()).or_insert_with(|| serde_json::json!({}));
            if let Some(map) = entry.as_object_mut() {
                let runs = map.entry("runs").or_insert_with(|| serde_json::json!({}));
                if let Some(runs_map) = runs.as_object_mut() {
                    runs_map.insert(format!("{}|{}", compute, power), run.clone());
                }
                // convenience copy of the latest measurement (overwritten each run):
                // a record, never a chosen optimum.
                map.insert("kind".to_string(), serde_json::json!("last-measurement"));
                for key in ["compute", "powerMode", "decodeTokPerSec", "ttftMs", "nctx", "verifiedNpu", "measuredAt"] {
                    map.insert(key.to_string(), run.get(key).cloned().unwrap_or(Value::Null));
                }
            }
        }
    }
}

/// Merges one successful single-model benchmark result into a hardware.json-shaped config.
fn record_bench_run(config: &mut Value, res: &BenchmarkResult, max_tokens: i32, ngl: i32, nctx: Option<u32>) {
    record_run(
        config,
        &res.model_ref,
        serde_json::json!({
            "compute": res.compute,
            "powerMode": res.power_mode,
            "decodeTokPerSec": res.decode_tok_per_sec,
            "ttftMs": res.ttft_ms,
            "tokensGenerated": res.tokens_generated,
            "maxTokens": max_tokens,
            "ngl": ngl,
            "nctx": nctx.unwrap_or(4096),
            "verifiedNpu": res.verified_npu,
            // B07: the child's own measured footprint and first-output time
            "childPrivateMemMB": res.child_private_mem_mb,
            "firstOutputMs": res.first_output_ms,
            "measuredAt": chrono_now_iso(),
        }),
    );
    if let Some(obj) = config.as_object_mut() {
        obj.insert("lastBenchmark".to_string(), serde_json::to_value(res).unwrap_or(Value::Null));
    }
}

/// Why a run the benchmark suite measured cannot be recorded, or None. The sidecar sends it;
/// only a complete, physical measurement of a named build is written.
pub(crate) fn suite_run_problem(model_ref: &str, run: &Value) -> Option<String> {
    if model_ref.trim().is_empty() || model_ref.len() > 300 {
        return Some("the run names no model build".to_string());
    }
    if !matches!(run["compute"].as_str(), Some("npu" | "hybrid" | "gpu" | "cpu")) {
        return Some("the run names no device it ran on".to_string());
    }
    match run["decodeTokPerSec"].as_f64() {
        Some(t) if t.is_finite() && t > 0.0 && t < 10_000.0 => {}
        _ => return Some("the run has no measured speed".to_string()),
    }
    if !matches!(run["powerMode"].as_str(), Some(p) if !p.is_empty() && p.len() <= 40) {
        return Some("the run names no power mode".to_string());
    }
    None
}

/// The benchmark suite's measured run, written through the same profile writer as the
/// single-model benchmark (args: [modelRef, run]). Stamps the time here, as the other path does.
pub fn record_suite_run(args: &Value) -> Result<Value, String> {
    let model_ref = args[0].as_str().unwrap_or("").to_string();
    let mut run = args[1].clone();
    if let Some(why) = suite_run_problem(&model_ref, &run) {
        return Err(format!("recordBenchRun: {}", why));
    }
    if let Some(obj) = run.as_object_mut() {
        obj.insert("measuredAt".to_string(), serde_json::json!(chrono_now_iso()));
        obj.insert("source".to_string(), serde_json::json!("benchmark-suite"));
    }
    let mut config = load_hardware_config();
    record_run(&mut config, &model_ref, run);
    save_hardware_config(config)?;
    Ok(Value::Bool(true))
}

/// B06: does the child's output AFFIRM NPU execution? Only an offload or device-selection
/// line in non-failure output counts — "offloaded N layers to HTP", "device: htp", a
/// loaded HTP graph. A mere mention of htp/hexagon (a backend banner, a probe such as
/// "ggml-hex: HTP0 started") and any failure/warning line prove nothing: a failed HTP
/// initialization names the NPU and ran on nothing.
fn affirmative_npu_log(lines: &[&str]) -> bool {
    lines.iter().any(|l| {
        let low = l.to_ascii_lowercase();
        if low.contains("fail") || low.contains("error") || low.contains("panic") || low.contains("warning") {
            return false;
        }
        let names_npu = low.contains("htp") || low.contains("hexagon") || low.contains("npu");
        if !names_npu {
            return false;
        }
        (low.contains("offload") || low.contains("layers to"))
            || low.contains("htp graph loaded")
            || (low.contains("device:") && names_npu)
            || (low.contains("using device") && names_npu)
    })
}

/// A real UTC ISO-8601 timestamp without a date-time crate: days-from-civil, inverted.
fn chrono_now_iso() -> String {
    let now = std::time::SystemTime::now();
    let dur = now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = dur.as_secs();
    let days = (secs / 86_400) as i64;
    // Howard Hinnant's civil_from_days
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let rem = secs % 86_400;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, m, d, rem / 3600, (rem % 3600) / 60, rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// B01 contract: the output budget rides on `--max-tokens`; `-n` (ngl) is set
    /// explicitly and never carries the token budget.
    #[test]
    fn infer_args_use_max_tokens_for_output_and_ngl_for_offload() {
        let args = build_infer_args("org/model-GGUF", "p", 24, -1, false, "burst", Some("npu"), Some(4096), None);
        let pos = |f: &str| args.iter().position(|a| a == f).expect("flag present");
        assert_eq!(args[pos("--max-tokens") + 1], "24");
        assert_eq!(args[pos("--ngl") + 1], "-1");
        // the shorthand must not appear at all
        assert!(!args.iter().any(|a| a == "-n"), "shorthand -n must not be used: it is --ngl");
        assert_eq!(args[pos("--compute") + 1], "npu");
        assert_eq!(args[pos("--nctx") + 1], "4096");
        assert_eq!(args[pos("--power-mode") + 1], "burst");
        assert_eq!(args[0], "infer");
        assert_eq!(args[1], "org/model-GGUF");
    }

    /// A QAIRT bundle takes NO compute/window flags: requesting them would lie about
    /// what the compiled artifact can do.
    #[test]
    fn infer_args_omit_compute_for_qairt() {
        let args = build_infer_args("qualcomm/Qwen3-4B", "p", 24, -1, false, "burst", None, None, None);
        assert!(!args.iter().any(|a| a == "--compute"));
        assert!(!args.iter().any(|a| a == "--nctx"));
        assert!(!args.iter().any(|a| a == "-n"));
        assert!(!args.iter().any(|a| a == "--qairt-lib"));
    }

    /// A native model is benchmarked against the same QAIRT runtime the chat server uses:
    /// on the X2 Elite the bundled runtime let the DSP load the driver's older skel.
    #[test]
    fn infer_args_carry_the_qairt_runtime_of_a_native_model() {
        let args = build_infer_args("qualcomm/Qwen3-8B", "p", 24, -1, false, "burst", None, None, Some(r"C:\MKMN\QAIRT\geniex-abc"));
        let pos = args.iter().position(|a| a == "--qairt-lib").expect("the runtime folder is passed");
        assert_eq!(args[pos + 1], r"C:\MKMN\QAIRT\geniex-abc");
    }

    /// A benchmark's calibration record is a LAST MEASUREMENT: a different compute
    /// must not overwrite the previous configuration's numbers (they live in `runs`).
    #[test]
    fn runs_are_kept_per_compute_and_power_mode() {
        // the shape the persistence writes: runs keyed by "<compute>|<power>"
        let key = format!("{}|{}", "cpu", "power_saver");
        assert_eq!(key, "cpu|power_saver");
    }

    fn sample_result(model_ref: &str, compute: &str, power: &str, speed: f64) -> BenchmarkResult {
        BenchmarkResult {
            model_ref: model_ref.to_string(),
            compute: compute.to_string(),
            power_mode: power.to_string(),
            ttft_ms: Some(210.0),
            decode_tok_per_sec: speed,
            prefill_tok_per_sec: None,
            load_time_ms: 1200,
            tokens_generated: 24,
            ram_used_mb: 3450.0,
            ram_scope: "system-wide-in-use".to_string(),
            load_time_measured: false,
            max_tokens: 24,
            ngl: -1,
            verified_npu: true,
            output_snippet: "25 * 4 = 100.".to_string(),
            child_private_mem_mb: None,
            first_output_ms: None,
        }
    }

    /// The benchmark suite writes through the same writer: its run lands under the exact build's
    /// ref and its own configuration key, beside the single-model benchmark's, which survives.
    #[test]
    fn a_suite_run_is_recorded_like_a_single_model_run() {
        let mut config = serde_json::json!({});
        let res = sample_result("org/model-GGUF:Q4_0", "npu", "burst", 20.0);
        record_bench_run(&mut config, &res, 24, -1, Some(4096));
        record_run(&mut config, "phi-4-mini-npu:2", serde_json::json!({
            "compute": "npu", "powerMode": "default", "decodeTokPerSec": 13.65, "ttftMs": 410.0,
            "verifiedNpu": false, "measuredAt": "2026-11-15T10:00:00Z", "source": "benchmark-suite"
        }));
        assert_eq!(config["calibratedProfiles"]["phi-4-mini-npu:2"]["runs"]["npu|default"]["decodeTokPerSec"], 13.65);
        assert_eq!(config["calibratedProfiles"]["phi-4-mini-npu:2"]["decodeTokPerSec"], 13.65);
        assert_eq!(config["calibratedProfiles"]["org/model-GGUF:Q4_0"]["runs"]["npu|burst"]["decodeTokPerSec"], 20.0);
    }

    #[test]
    fn a_suite_run_without_a_device_or_a_speed_is_refused() {
        let ok = serde_json::json!({ "compute": "npu", "powerMode": "default", "decodeTokPerSec": 13.65 });
        assert_eq!(suite_run_problem("m:1", &ok), None);
        assert!(suite_run_problem("", &ok).is_some());
        assert!(suite_run_problem("m:1", &serde_json::json!({ "compute": "unknown", "powerMode": "default", "decodeTokPerSec": 1.0 })).is_some());
        assert!(suite_run_problem("m:1", &serde_json::json!({ "compute": "npu", "powerMode": "default", "decodeTokPerSec": 0.0 })).is_some());
        assert!(suite_run_problem("m:1", &serde_json::json!({ "compute": "npu", "powerMode": "default" })).is_some());
    }

    /// The merge keeps every earlier configuration's run and records the new one; the
    /// renderer's chips (core/benchStore.ts) read exactly this shape.
    #[test]
    fn record_bench_run_keeps_other_configurations_and_adds_the_new_one() {
        let mut config = serde_json::json!({
            "calibratedProfiles": {
                "org/model-GGUF": {
                    "runs": {
                        "cpu|power_saver": { "compute": "cpu", "powerMode": "power_saver", "decodeTokPerSec": 3.0, "measuredAt": "2026-01-01T00:00:00Z" }
                    }
                }
            }
        });
        let res = sample_result("org/model-GGUF", "npu", "burst", 64.8);
        record_bench_run(&mut config, &res, 24, -1, Some(4096));
        let runs = config["calibratedProfiles"]["org/model-GGUF"]["runs"].as_object().unwrap();
        // the earlier configuration's measurement survived…
        assert!(runs.contains_key("cpu|power_saver"));
        assert_eq!(runs["cpu|power_saver"]["decodeTokPerSec"], 3.0);
        // …and the new one is recorded under its own key, fully shaped
        assert_eq!(runs["npu|burst"]["decodeTokPerSec"], 64.8);
        assert_eq!(runs["npu|burst"]["ttftMs"], 210.0);
        assert_eq!(runs["npu|burst"]["nctx"], 4096);
        assert_eq!(runs["npu|burst"]["verifiedNpu"], true);
        assert!(runs["npu|burst"]["measuredAt"].as_str().unwrap().ends_with('Z'));
        assert_eq!(config["lastBenchmark"]["modelRef"], "org/model-GGUF");
    }

    /// A re-measured configuration REPLACES its own run (the newest wins for that key)
    /// without touching other keys.
    #[test]
    fn record_bench_run_replaces_only_its_own_configuration() {
        let mut config = serde_json::json!({
            "calibratedProfiles": {
                "m": { "runs": { "npu|burst": { "compute": "npu", "powerMode": "burst", "decodeTokPerSec": 40.0, "measuredAt": "2026-01-01T00:00:00Z" },
                                  "npu|power_saver": { "compute": "npu", "powerMode": "power_saver", "decodeTokPerSec": 12.0, "measuredAt": "2026-02-01T00:00:00Z" } } }
            }
        });
        let res = sample_result("m", "npu", "burst", 64.8);
        record_bench_run(&mut config, &res, 24, -1, None);
        let runs = config["calibratedProfiles"]["m"]["runs"].as_object().unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs["npu|burst"]["decodeTokPerSec"], 64.8);
        assert_eq!(runs["npu|power_saver"]["decodeTokPerSec"], 12.0);
        assert_eq!(runs["npu|burst"]["nctx"], 4096); // the default when nctx is None
    }

    /// A different model's profile is untouched by another model's run.
    #[test]
    fn record_bench_run_is_scoped_to_its_model_ref() {
        let mut config = serde_json::json!({
            "calibratedProfiles": { "other": { "runs": { "npu|burst": { "decodeTokPerSec": 9.0 } } } }
        });
        let res = sample_result("m", "npu", "burst", 64.8);
        record_bench_run(&mut config, &res, 24, -1, None);
        assert_eq!(config["calibratedProfiles"]["other"]["runs"]["npu|burst"]["decodeTokPerSec"], 9.0);
        assert!(config["calibratedProfiles"]["m"]["runs"]["npu|burst"].is_object());
    }

    #[test]
    fn telemetry_parses_the_geniex_summary_line() {
        let (speed, tokens, ttft) = parse_infer_telemetry("some noise\n— 64.8 tok/s • 9 tok • 0.21 s first token —\n");
        assert_eq!(speed, Some(64.8));
        assert_eq!(tokens, Some(9));
        assert_eq!(ttft, Some(0.21));
    }

    /// The runtime prints "0.0 s first token" when it did NOT measure the first token
    /// (the real Qwen3-0.6B run) — a figure no first token can have. It must be read
    /// as absent, never stored as ttftMs 0 and displayed as "first token in 0 ms".
    #[test]
    fn an_impossible_zero_first_token_is_absent_not_a_measurement() {
        let (speed, tokens, ttft) = parse_infer_telemetry("some noise\n— 64.8 tok/s • 9 tok • 0.0 s first token —\n");
        assert_eq!(speed, Some(64.8)); // the speed is real and still measured
        assert_eq!(tokens, Some(9));
        assert_eq!(ttft, None);
    }

    /// A result without a measured first token serializes null (the honest shape the
    /// renderer parses into "not measured"), and a real one keeps its milliseconds.
    #[test]
    fn ttft_serializes_as_null_when_it_was_never_measured() {
        let mut res = sample_result("m", "npu", "burst", 64.8);
        assert_eq!(res.ttft_ms, Some(210.0));
        let with = serde_json::to_value(&res).unwrap();
        assert_eq!(with["ttftMs"], 210.0);
        res.ttft_ms = None;
        let without = serde_json::to_value(&res).unwrap();
        assert!(without["ttftMs"].is_null());
    }

    #[test]
    fn telemetry_is_absent_without_the_line() {
        let (speed, tokens, ttft) = parse_infer_telemetry("nothing useful here");
        assert_eq!((speed, tokens, ttft), (None, None, None));
    }

    #[test]
    fn iso_timestamp_is_real_utc() {
        let iso = chrono_now_iso();
        // shape: 2026-11-06T12:34:56Z
        assert!(iso.len() == 20 && iso.ends_with('Z') && iso.as_bytes()[10] == b'T', "got {}", iso);
        let year: i64 = iso[..4].parse().unwrap();
        assert!(year >= 2026, "got {}", iso);
    }

    /// B06: a line that only MENTIONS a device is not execution evidence; an
    /// affirmative offload / device-selection line in non-failure output is.
    #[test]
    fn npu_log_evidence_requires_affirmative_lines() {
        // mere backend banner / probe: not execution
        assert!(!affirmative_npu_log(&["ggml-hex: HTP0 started", "loading model"]));
        // failed initialization: names the NPU, ran on nothing
        assert!(!affirmative_npu_log(&["ggml-hex backend failed to initialize"]));
        // failure lines are excluded even when they name an offload
        assert!(!affirmative_npu_log(&["error: offload to HTP rejected"]));
        // affirmative evidence
        assert!(affirmative_npu_log(&["offloaded 28 layers to HTP"]));
        assert!(affirmative_npu_log(&["loaded 28 layers to htp"]));
        assert!(affirmative_npu_log(&["htp graph loaded"]));
        assert!(affirmative_npu_log(&["device: htp"]));
        assert!(affirmative_npu_log(&["using device npu"]));
        // a CPU-only run names no NPU device
        assert!(!affirmative_npu_log(&["offloaded 28 layers to cpu"]));
        // mixed output: failure lines do not veto affirmative evidence
        assert!(affirmative_npu_log(&["ggml-hex: HTP0 started", "offloaded 28 layers to HTP", "warning: busy"]));
    }

    #[test]
    fn new_result_fields_survive_a_roundtrip() {
        // older builds stored results without these fields: they must still deserialize
        let old = r#"{"modelRef":"m","compute":"npu","powerMode":"burst","ttftMs":1.0,"decodeTokPerSec":2.0,
            "prefillTokPerSec":null,"loadTimeMs":10,"tokensGenerated":9,"ramUsedMB":1.0,"ramScope":"system-wide-in-use",
            "loadTimeMeasured":false,"maxTokens":24,"ngl":-1,"verifiedNpu":true,"outputSnippet":"x"}"#;
        let r: BenchmarkResult = serde_json::from_str(old).expect("old JSON must still parse");
        assert_eq!(r.child_private_mem_mb, None);
        assert_eq!(r.first_output_ms, None);
        let with = r#"{"childPrivateMemMB":512.5,"firstOutputMs":350,"modelRef":"m","compute":"npu","powerMode":"burst","ttftMs":1.0,"decodeTokPerSec":2.0,
            "prefillTokPerSec":null,"loadTimeMs":10,"tokensGenerated":9,"ramUsedMB":1.0,"ramScope":"system-wide-in-use",
            "loadTimeMeasured":false,"maxTokens":24,"ngl":-1,"verifiedNpu":true,"outputSnippet":"x"}"#;
        let r: BenchmarkResult = serde_json::from_str(with).expect("new fields must parse");
        assert_eq!(r.child_private_mem_mb, Some(512.5));
        assert_eq!(r.first_output_ms, Some(350));
    }
}
