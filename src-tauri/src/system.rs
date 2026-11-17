use std::process::Command;
use std::sync::RwLock;
use std::time::{Duration, Instant};
use serde_json::Value;

static MODELS_CACHE: RwLock<Option<(Instant, Value)>> = RwLock::new(None);
use crate::bench::load_hardware_config;
use crate::memory_estimator::get_available_ram_bytes;
use crate::supervisor::GenieXSupervisor;

/// The CPU's marketing name from the registry (HKLM\HARDWARE\DESCRIPTION\...\CentralProcessor\0),
/// or None when it cannot be read — never a hard-coded machine identity.
fn cpu_name() -> Option<String> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ, RRF_RT_REG_SZ,
    };
    let path: Vec<u16> = "HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0\0".encode_utf16().collect();
    let mut key: HKEY = std::ptr::null_mut();
    if unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, path.as_ptr(), 0, KEY_READ, &mut key) } != 0 {
        return None;
    }
    let name: Vec<u16> = "ProcessorNameString\0".encode_utf16().collect();
    let mut size: u32 = 0;
    let status = unsafe {
        RegGetValueW(key, std::ptr::null(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), std::ptr::null_mut(), &mut size)
    };
    if status != 0 || size == 0 {
        unsafe { RegCloseKey(key) };
        return None;
    }
    let mut buf = vec![0u16; (size as usize) / 2];
    let status = unsafe {
        RegGetValueW(key, std::ptr::null(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr() as *mut core::ffi::c_void, &mut size)
    };
    unsafe { RegCloseKey(key) };
    if status != 0 {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let s = String::from_utf16_lossy(&buf[..len]).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Some Snapdragon systems expose Hexagon through the ComputeAccelerator PnP
/// class without listing it in the DirectX registry.
pub(crate) fn started_npu_device() -> Option<(String, Option<String>)> {
    use windows_sys::Win32::Devices::DeviceAndDriverInstallation::*;
    use windows_sys::Win32::System::Registry::{KEY_READ, RRF_RT_REG_SZ, RegCloseKey, RegGetValueW};
    use windows_sys::core::GUID;
    const COMPUTE_ACCELERATOR: GUID = GUID::from_u128(0xf01a9d53_3ff6_48d2_9f97_c8a7004be10c);
    unsafe {
        let set = SetupDiGetClassDevsW(&COMPUTE_ACCELERATOR, std::ptr::null(), std::ptr::null_mut(), DIGCF_PRESENT);
        if set == -1 {
            return None;
        }
        let mut device: SP_DEVINFO_DATA = std::mem::zeroed();
        device.cbSize = std::mem::size_of::<SP_DEVINFO_DATA>() as u32;
        let mut found = None;
        for index in 0.. {
            if SetupDiEnumDeviceInfo(set, index, &mut device) == 0 {
                break;
            }
            let (mut status, mut problem) = (0, 0);
            if CM_Get_DevNode_Status(&mut status, &mut problem, device.DevInst, 0) != 0 || status & DN_STARTED == 0 {
                continue;
            }
            let name = [SPDRP_FRIENDLYNAME, SPDRP_DEVICEDESC].into_iter().find_map(|property| {
                let mut value = [0u16; 256];
                let ok = SetupDiGetDeviceRegistryPropertyW(set, &device, property, std::ptr::null_mut(),
                    value.as_mut_ptr().cast(), std::mem::size_of_val(&value) as u32, std::ptr::null_mut());
                (ok != 0).then(|| String::from_utf16_lossy(&value[..value.iter().position(|c| *c == 0).unwrap_or(value.len())]))
            });
            let Some(name) = name.filter(|name| crate::npudiag::looks_like_npu(name)) else { continue };
            let key = SetupDiOpenDevRegKey(set, &device, DICS_FLAG_GLOBAL, 0, DIREG_DRV, KEY_READ);
            let driver = if key == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE || key.is_null() {
                None
            } else {
                let property: Vec<u16> = "DriverVersion\0".encode_utf16().collect();
                let mut value = [0u16; 64];
                let mut bytes = std::mem::size_of_val(&value) as u32;
                let result = RegGetValueW(key, std::ptr::null(), property.as_ptr(), RRF_RT_REG_SZ,
                    std::ptr::null_mut(), value.as_mut_ptr().cast(), &mut bytes);
                RegCloseKey(key);
                (result == 0).then(|| String::from_utf16_lossy(&value[..value.iter().position(|c| *c == 0).unwrap_or(value.len())]))
            };
            found = Some((name, driver));
            break;
        }
        SetupDiDestroyDeviceInfoList(set);
        found
    }
}

/// The version package.json declares — the single source of the version, embedded at
/// compile time by build.rs (MKMN_APP_VERSION). Falls back to the Cargo version when the
/// build script could not read it, so a number is always shown.
pub fn app_version() -> &'static str {
    match option_env!("MKMN_APP_VERSION") {
        Some(v) if !v.is_empty() => v,
        _ => env!("CARGO_PKG_VERSION"),
    }
}

/// The GenieX executable and its version, cached: `geniex version` spawns a process, and
/// the info panel asks for it on every settings render. The executable rarely changes
/// while the app runs; a short TTL keeps a freshly installed GenieX discoverable.
fn cached_geniex_info() -> (Option<String>, Option<String>) {
    use std::sync::RwLock;
    use std::time::Instant;
    /// When it was read, the GenieX path, the GenieX version.
    type Cached = (Instant, Option<String>, Option<String>);
    static CACHE: RwLock<Option<Cached>> = RwLock::new(None);
    const TTL: Duration = Duration::from_secs(60);
    if let Ok(guard) = CACHE.read()
        && let Some((at, path, version)) = guard.as_ref()
            && at.elapsed() < TTL {
                return (path.clone(), version.clone());
            }
    let geniex_path = GenieXSupervisor::find_geniex(None);
    let geniex_str = geniex_path.as_ref().map(|p| p.to_string_lossy().to_string());
    // the capability probe reads `--version` (with `--skip-update`, and again without it for a CLI that does not know
    // the flag), cached per executable identity: the same reading the server start's minimum-version gate uses
    let geniex_version = geniex_path.and_then(|p| crate::capabilities::probe(&p).geniex_version);
    if let Ok(mut guard) = CACHE.write() {
        *guard = Some((Instant::now(), geniex_str.clone(), geniex_version.clone()));
    }
    (geniex_str, geniex_version)
}

pub fn get_app_info() -> Value {
    let (geniex_str, geniex_output) = cached_geniex_info();
    // GenieX v0.11.0 or newer is mandatory for inference: the window says so when it is off
    let geniex_warning = crate::capabilities::version_warning(geniex_str.as_deref().map(std::path::Path::new), geniex_output.as_deref());
    let geniex_version = geniex_output;

    serde_json::json!({
        "version": app_version(),
        "arch": "arm64",
        "platform": "win32",
        "geniexPath": geniex_str,
        "geniexVersion": geniex_version,
        "geniexVersionWarning": geniex_warning,
        "problems": []
    })
}

pub fn get_hardware() -> Value {
    let cpu_threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(12);

    let (avail_bytes, total_bytes) = get_available_ram_bytes();
    let gb = 1024.0 * 1024.0 * 1024.0;
    let total_gb = (total_bytes as f64 / gb * 10.0).round() / 10.0;
    let avail_gb = (avail_bytes as f64 / gb * 10.0).round() / 10.0;
    let npu_budget = (total_gb * 0.75 * 10.0).round() / 10.0;

    let hw_config = load_hardware_config();

    // Real machine identity: the CPU name from the registry and the adapters Windows
    // actually has. Nothing here is hard-coded to one SKU.
    let cpu = cpu_name().unwrap_or_else(|| "Unknown CPU".to_string());
    let adapters = crate::npudiag::directx_adapters();
    let gpus: Vec<Value> = adapters.iter()
        .filter(|a| !crate::npudiag::looks_like_npu(&a.description))
        .map(|a| serde_json::json!({ "name": a.description, "vramGB": null }))
        .collect();
    let npu_adapters: Vec<&crate::npudiag::DirectXAdapter> = adapters.iter()
        .filter(|a| crate::npudiag::looks_like_npu(&a.description))
        .collect();
    let pnp = if npu_adapters.is_empty() { started_npu_device() } else { None };
    let npu_name = if npu_adapters.is_empty() {
        pnp.as_ref().map(|(name, _)| name.clone())
    } else {
        Some(npu_adapters.iter().map(|a| a.description.as_str()).collect::<Vec<_>>().join(", "))
    };
    let npu = if npu_name.is_none() {
        serde_json::json!({
            "name": null,
            "tops": null,
            "available": false,
            "note": "Windows reported no active NPU adapter."
        })
    } else {
        serde_json::json!({
            "name": npu_name,
            // A TOPS figure is a datasheet claim, not a measurement: report it unknown.
            "tops": null,
            "available": true
        })
    };

    let npu_detected = npu_name.is_some();
    let npu_driver_version = npu_adapters
        .iter()
        .filter_map(|a| a.driver_version.clone())
        .next()
        .or_else(|| pnp.and_then(|(_, version)| version));

    // The shared HardwareProfile contract (src/shared/types.ts): consumers read
    // chipName/isSnapdragon/npuDetected/npuDriverVersion/npuBudgetSource/appArch/
    // emulated. Missing fields silently read as false/null there, which made a real
    // Snapdragon NPU look unavailable. Real identity only: nothing hard-coded.
    let is_snapdragon = cpu.to_lowercase().contains("snapdragon") || npu_detected;
    let chip_family = if is_snapdragon && cpu.to_lowercase().contains("x2") {
        "x2"
    } else if is_snapdragon {
        "x1"
    } else {
        "unknown"
    };
    // One architecture identity across the app: Rust's ARCH constant says "aarch64",
    // every TypeScript consumer (backendChoices, buildProfile, the UI and the tests)
    // says "arm64". Normalizing here at the host boundary keeps the two from drifting
    // — an unnormalized value made backendChoices mark the NPU unavailable on a real
    // ARM64 PC, and buildProfile's emulated flag true.
    let app_arch = if std::env::consts::ARCH == "aarch64" { "arm64" } else { std::env::consts::ARCH }.to_string();
    // This build ships ARM64-only: an x64 process on this machine means emulation.
    let emulated = app_arch != "arm64";

    serde_json::json!({
        "platform": "win32",
        "arch": "arm64",
        "chipName": cpu,
        "chipFamily": chip_family,
        "isSnapdragon": is_snapdragon,
        "cpuName": cpu,
        "cpuThreads": cpu_threads,
        "ramGB": total_gb,
        "availableRamGB": avail_gb,
        "npuBudgetGB": npu_budget,
        "npuBudgetSource": "estimated",
        "npuDetected": npu_detected,
        "npuPresent": npu_detected,
        "npuType": npu.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()),
        "npuDriverVersion": npu_driver_version,
        "appArch": app_arch,
        "emulated": emulated,
        "detectedAt": chrono_lite_iso_now(),
        "gpus": gpus,
        "npu": npu,
        "calibratedProfiles": hw_config.get("calibratedProfiles").cloned().unwrap_or(serde_json::json!({})),
        "lastBenchmark": hw_config.get("lastBenchmark").cloned().unwrap_or(Value::Null),
        "problems": []
    })
}

/// A plain ISO-8601 UTC timestamp without pulling in a date crate.
fn chrono_lite_iso_now() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil-from-days (Howard Hinnant's algorithm), years from 1970-01-01.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, d, h, m, s
    )
}

pub fn list_installed_models() -> Value {
    if let Ok(guard) = MODELS_CACHE.read()
        && let Some((ts, ref val)) = *guard
            && ts.elapsed() < Duration::from_secs(5) {
                return val.clone();
            }
    let geniex_path = match GenieXSupervisor::find_geniex(None) {
        Some(p) => p,
        None => return serde_json::json!([]),
    };

    // No --data-dir override: GenieX knows its own cache (~/.cache/geniex), and pointing
    // it at %LOCALAPPDATA%\GenieX made `list` (and `serve`) see an empty model set.
    let mut cmd = Command::new(geniex_path);
    cmd.args(["list", "--format", "json"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = match cmd.output() {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
        Err(_) => return serde_json::json!([]),
    };

    // First attempt: parse JSON format directly
    if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&output) {
        let mut models = Vec::new();
        for item in items {
            if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
                // the renderer reads sizeGB as a NUMBER (InstalledModel.sizeGB), bytes as given
                let size_gb = item
                    .get("size")
                    .and_then(|v| v.as_u64())
                    .map(|bytes| (bytes as f64 / 1_073_741_824.0 * 10.0).round() / 10.0);

                models.push(serde_json::json!({
                    "name": name,
                    "ref": name,
                    "size": size_gb.map(|g| format!("{:.1} GB", g)).unwrap_or_default(),
                    "sizeGB": size_gb,
                    "installed": true,
                    "runtime": item.get("runtime").and_then(|v| v.as_str()),
                    "type": item.get("type").and_then(|v| v.as_str()),
                    "precisions": item.get("precisions")
                }));
            }
        }
        // Cache the parsed JSON result too — this is the path that normally runs, and
        // without this write every catalog refresh spawned `geniex list` again.
        let res = serde_json::json!(models);
        if let Ok(mut guard) = MODELS_CACHE.write() {
            *guard = Some((Instant::now(), res.clone()));
        }
        return res;
    }

    // Fallback: parse table text format
    let mut models = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('+') || trimmed.starts_with('|') && trimmed.contains("NAME") {
            continue;
        }
        
        let parts: Vec<&str> = trimmed.split('|')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();

        if !parts.is_empty() {
            let name = parts[0];
            let size = parts.get(1).unwrap_or(&"");
            models.push(serde_json::json!({
                "name": name,
                "ref": name,
                "size": size,
                "installed": true
            }));
        }
    }

    let res = serde_json::json!(models);
    if let Ok(mut guard) = MODELS_CACHE.write() {
        *guard = Some((Instant::now(), res.clone()));
    }
    res
}


/// Orphaned-WebView2 cleanup, rewritten after the incident.
///
/// The OLD implementation killed every `msedgewebview2.exe` whose command line
/// contained "app.mkmn.desktop" and that was older than this launch. That heuristic
/// murdered the WebView2 processes of LIVE MKMN instances: the age filter only
/// protected THIS launch's own webview, and the substring matched every sibling
/// instance. Each victim kept running with a dead webview (0x8007139F on every
/// metrics emit), showed nothing, and never exited — the accumulated hang.
///
/// The rules now:
/// 1. Candidate = an msedgewebview2 process whose `--user-data-dir` equals THIS
///    build's WebView2 data folder (exact path match, not a loose substring). Other
///    applications' WebView2 processes can never match, and a dev build cannot touch
///    the installed app's browser processes.
/// 2. Ownership walk: from the candidate, follow parent PIDs to the MKMN.exe host
///    that created the environment.
///    - A LIVE MKMN.exe owner (including this very process) ⇒ LEAVE ALONE.
///    - The owner PID no longer exists, or was recycled by an unrelated process
///      (so the real owner is dead) ⇒ the webview is truly orphaned ⇒ terminate it.
///    - Anything ambiguous ⇒ LEAVE IT ALONE and log the conflict. Never guess.
/// 3. Age is never used as ownership evidence. A crashed instance's browser
///    processes are normally contained by the job object (KILL_ON_JOB_CLOSE); this
///    scan is the fallback for the no-containment case, not a routine hammer.
pub fn cleanup_stray_webview_processes() {
    let t0 = std::time::Instant::now();
    let udf = crate::paths::webview_data_dir();
    let udf = match udf.to_str() {
        Some(s) => s.to_string(),
        None => return, // non-UTF-8 path: nothing to match on, never guess
    };

    // One PowerShell pass: the raw material (no secrets — only pids, parent pids,
    // process names, and the msedgewebview2 command lines' --user-data-dir flags).
    // All DECISIONS are made in Rust, where they are unit-testable. Lines are
    // prefixed C (webview candidate: pid, ppid, command line) or P (walk-table row:
    // pid, ppid, name), fields separated by the ASCII unit separator.
    let script = concat!(
        "$ErrorActionPreference='SilentlyContinue'; $s=[char]31; ",
        "$w=Get-CimInstance Win32_Process -Filter \"Name = 'msedgewebview2.exe'\"; ",
        "foreach ($x in $w) { Write-Output ('C' + $s + $x.ProcessId + $s + $x.ParentProcessId + $s + $x.CommandLine) }; ",
        "$a=Get-CimInstance Win32_Process; ",
        "foreach ($x in $a) { Write-Output ('P' + $s + $x.ProcessId + $s + $x.ParentProcessId + $s + $x.Name) }"
    );
    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = cmd.output();

    let output = match output {
        Ok(o) if o.status.success() => o.stdout,
        Ok(o) => {
            crate::paths::startup_log(
                "stray-webview-scan",
                &format!(
                    "scan failed (status {:?}); no orphan cleanup was attempted this launch",
                    o.status.code()
                ),
            );
            return;
        }
        Err(e) => {
            crate::paths::startup_log("stray-webview-scan", &format!("scan could not run: {e}"));
            return;
        }
    };

    let text = String::from_utf8_lossy(&output);
    let (candidates, table) = match parse_scan_output(&text) {
        Ok(v) => v,
        Err(e) => {
            crate::paths::startup_log(
                "stray-webview-scan",
                &format!("scan output could not be parsed ({e}); no orphan cleanup was attempted"),
            );
            return;
        }
    };

    // Exact-path filter: only webviews whose user-data folder is OURS.
    let udf_lower = udf.to_lowercase();
    let ours: Vec<ProcessInfo> = candidates
        .into_iter()
        .filter(|c| {
            matches!(
                webview_user_data_dir(&c.command_line),
                Some(dir) if dir.to_string_lossy().to_lowercase() == udf_lower
            )
        })
        .map(|c| ProcessInfo { pid: c.pid, parent_pid: c.parent_pid, name: "msedgewebview2.exe".into(), command_line: c.command_line })
        .collect();

    if ours.is_empty() {
        crate::paths::startup_log(
            "stray-webview-scan",
            &format!(
                "no orphaned WebView2 processes for this profile ({} processes scanned, {} ms)",
                table.len(),
                t0.elapsed().as_millis()
            ),
        );
        return;
    }

    let decisions = decide_stray_webviews(&ours, &table);
    let mut killed = 0usize;
    for (pid, verdict, reason) in &decisions {
        match verdict {
            StrayVerdict::Kill => {
                let ok = terminate_process_tree(*pid);
                if ok {
                    killed += 1;
                }
                crate::paths::startup_log(
                    "stray-webview-scan",
                    &format!("webview pid {pid}: {} -> kill {}", reason, if ok { "done" } else { "FAILED (left running)" }),
                );
            }
            StrayVerdict::LeaveLiveOwner => {
                crate::paths::startup_log(
                    "stray-webview-scan",
                    &format!("webview pid {pid}: {reason} -> left alone"),
                );
            }
            StrayVerdict::LeaveAmbiguous => {
                crate::paths::startup_log(
                    "stray-webview-scan",
                    &format!(
                        "webview pid {pid}: {reason} -> left alone (ownership ambiguous; \
                         resolve manually via Task Manager if it is actually stuck)"
                    ),
                );
            }
        }
    }
    crate::paths::startup_log(
        "stray-webview-scan",
        &format!(
            "finished: {} candidates, {killed} orphans terminated, {} left untouched ({} ms)",
            decisions.len(),
            decisions.len() - killed,
            t0.elapsed().as_millis()
        ),
    );
}

/// A raw process record from the scan. `command_line` is only populated for
/// msedgewebview2 candidates; the walk table carries names only.
#[derive(Clone, Debug, PartialEq)]
pub struct ProcessInfo {
    pub pid: u32,
    pub parent_pid: u32,
    pub name: String,
    /// Only for webview candidates; empty for the walk table.
    pub command_line: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StrayVerdict {
    /// The webview's owning MKMN process is gone: it is truly orphaned.
    Kill,
    /// A live MKMN process (possibly this one) owns this webview.
    LeaveLiveOwner,
    /// Ownership could not be established with confidence.
    LeaveAmbiguous,
}

/// Max depth of the parent walk: a guard against pathological cycles, not a real
/// expectation — the chain is webview → browser → MKMN host (2 hops).
const MAX_WALK_DEPTH: usize = 32;

/// The pure, unit-tested decision core: for each candidate webview, walk parent
/// PIDs through `table` until an MKMN.exe owner is found (alive ⇒ leave), a missing
/// parent is hit (owner dead ⇒ kill), or the walk gets stuck (ambiguous ⇒ leave).
pub fn decide_stray_webviews(
    candidates: &[ProcessInfo],
    table: &std::collections::HashMap<u32, ProcessInfo>,
) -> Vec<(u32, StrayVerdict, String)> {
    let mut verdicts = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let mut current = candidate.clone();
        let mut depth = 0usize;
        let verdict = loop {
            if depth > MAX_WALK_DEPTH {
                break StrayVerdict::LeaveAmbiguous
                    .with("parent chain did not terminate within the walk bound");
            }
            match table.get(&current.parent_pid) {
                None => break StrayVerdict::Kill.with(format!(
                    "owning process {} no longer exists",
                    current.parent_pid
                )),
                Some(parent) => {
                    if parent.name.eq_ignore_ascii_case("mkmn.exe")
                        || parent.pid == std::process::id()
                    {
                        // A live MKMN host — including THIS process. PID equality also
                        // covers a test/odd environment where the host name differs.
                        break StrayVerdict::LeaveLiveOwner.with(format!(
                            "owned by live MKMN process {}",
                            parent.pid
                        ));
                    }
                    // Not MKMN: either an intermediate webview2 process (renderer →
                    // browser → host), or a RECYCLED pid. Keep walking either way —
                    // if the chain dead-ends, the real owner is gone.
                    current = parent.clone();
                    depth += 1;
                }
            }
        };
        verdicts.push((candidate.pid, verdict.0, verdict.1));
    }
    verdicts
}

impl StrayVerdict {
    fn with(self, reason: impl Into<String>) -> (StrayVerdict, String) {
        (self, reason.into())
    }
}

/// Extracts the `--user-data-dir` value from an msedgewebview2 command line.
/// Handles the quoted form (`--user-data-dir="C:\path with spaces"`) and the bare
/// form. This — not a loose substring — is what proves a webview belongs to THIS
/// build's profile.
pub fn webview_user_data_dir(command_line: &str) -> Option<std::path::PathBuf> {
    const FLAG: &str = "--user-data-dir=";
    let idx = command_line.find(FLAG)?;
    let rest = &command_line[idx + FLAG.len()..];
    if let Some(stripped) = rest.strip_prefix('"') {
        let end = stripped.find('"')?;
        Some(std::path::PathBuf::from(&stripped[..end]))
    } else {
        let end = rest.find(" --").unwrap_or(rest.len());
        let value = rest[..end].trim().trim_matches('"');
        if value.is_empty() { None } else { Some(std::path::PathBuf::from(value)) }
    }
}

/// Parses the scan's prefixed, unit-separated lines into (candidates, walk table).
/// Unparseable rows are skipped rather than failing the whole scan.
fn parse_scan_output(
    text: &str,
) -> Result<(Vec<ProcessInfo>, std::collections::HashMap<u32, ProcessInfo>), String> {
    let mut candidates = Vec::new();
    let mut table = std::collections::HashMap::new();

    for line in text.lines() {
        let line = line.trim_end_matches(['\r']);
        let Some(rest) = line.strip_prefix('C').or_else(|| line.strip_prefix('P')) else {
            continue; // unrelated PowerShell chatter
        };
        let kind = line.as_bytes()[0] as char;
        // After the kind letter comes the first unit separator: skip it so the
        // fields line up (pid, ppid, payload…).
        let rest = rest.strip_prefix('\u{1f}').unwrap_or(rest);
        let parts: Vec<&str> = rest.split('\u{1f}').collect();
        if parts.len() < 3 {
            continue;
        }
        let Ok(pid) = parts[0].trim().parse::<u32>() else { continue };
        let Ok(ppid) = parts[1].trim().parse::<u32>() else { continue };
        match kind {
            'C' => candidates.push(ProcessInfo {
                pid,
                parent_pid: ppid,
                name: "msedgewebview2.exe".into(),
                command_line: parts[2..].join("\u{1f}"),
            }),
            _ => {
                table.insert(pid, ProcessInfo {
                    pid,
                    parent_pid: ppid,
                    name: parts[2].trim().to_string(),
                    command_line: String::new(),
                });
            }
        }
    }

    Ok((candidates, table))
}

/// Terminates a verified-orphaned webview process and its children. Returns false
/// (logged by the caller) when the process could not be terminated — it is then
/// left running, never half-treated.
fn terminate_process_tree(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "requires a Windows PC with a started Hexagon ComputeAccelerator device"]
    fn live_hexagon_device_is_reported_without_a_directx_adapter() {
        let (name, version) = super::started_npu_device().expect("Windows did not report a started Hexagon device");
        assert!(name.contains("Hexagon"), "{name}");
        let hardware = super::get_hardware();
        assert_eq!(hardware["npuDetected"], true);
        assert!(version.is_some(), "the driver registry key did not carry its version");
        assert_eq!(hardware["npuDriverVersion"].as_str(), version.as_deref());
    }
    use super::*;
    use std::collections::HashMap;

    fn proc(pid: u32, ppid: u32, name: &str) -> ProcessInfo {
        ProcessInfo { pid, parent_pid: ppid, name: name.into(), command_line: String::new() }
    }

    fn table(entries: &[ProcessInfo]) -> HashMap<u32, ProcessInfo> {
        entries.iter().map(|p| (p.pid, p.clone())).collect()
    }

    fn candidate(pid: u32, ppid: u32, cmd: &str) -> ProcessInfo {
        ProcessInfo { pid, parent_pid: ppid, name: "msedgewebview2.exe".into(), command_line: cmd.into() }
    }

    const UDF: &str = r#"C:\Users\u\AppData\Local\app.mkmn.desktop\EBWebView"#;

    /// Regression for the incident: a live MKMN instance's webview must
    /// NEVER be killed, no matter how old it is. The old code killed exactly this.
    #[test]
    fn a_live_owners_webview_is_never_killed() {
        // webview 10 → browser 20 → MKMN host 30 (alive)
        let t = table(&[proc(20, 30, "msedgewebview2.exe"), proc(30, 1, "MKMN.exe")]);
        let v = decide_stray_webviews(&[candidate(10, 20, "")], &t);
        assert_eq!(v[0].1, StrayVerdict::LeaveLiveOwner, "live owner ⇒ untouched");
        // The old code's fatal case: the webview is OLDER than this launch. Age is
        // not part of the decision at all now.
        // A webview whose owner is another (live) MKMN instance is equally protected.
        let t2 = table(&[proc(40, 50, "msedgewebview2.exe"), proc(50, 1, "mkmn.exe")]);
        let v2 = decide_stray_webviews(&[candidate(40, 50, "")], &t2);
        assert_eq!(v2[0].1, StrayVerdict::LeaveLiveOwner);
    }

    /// A webview whose MKMN owner is gone IS an orphan and gets cleaned up.
    #[test]
    fn a_dead_owners_webview_is_terminated() {
        // webview 10 → browser 20; MKMN host 30 NOT in the table (dead, pid not reused)
        let t = table(&[proc(20, 30, "msedgewebview2.exe")]);
        let v = decide_stray_webviews(&[candidate(10, 20, "")], &t);
        assert_eq!(v[0].1, StrayVerdict::Kill, "owner gone ⇒ orphan ⇒ kill");
    }

    /// PID reuse: the recorded parent pid belongs to a live, unrelated process. The
    /// real owner (an MKMN that died) cannot be that process, so the webview is an
    /// orphan. Walking until the chain dead-ends handles this correctly.
    #[test]
    fn a_recycled_owner_pid_is_treated_as_a_dead_owner() {
        // webview 10 → browser 20 → pid 30 (now a LIVE, unrelated process)
        let t = table(&[proc(20, 30, "msedgewebview2.exe"), proc(30, 1, "explorer.exe")]);
        let v = decide_stray_webviews(&[candidate(10, 20, "")], &t);
        assert_eq!(v[0].1, StrayVerdict::Kill, "reused pid ⇒ true owner is gone");
    }

    /// Unrelated applications' WebView2 processes never match the profile filter.
    #[test]
    fn foreign_webviews_never_match_this_profile() {
        assert_ne!(
            webview_user_data_dir(
                r#"msedgewebview2.exe --user-data-dir="C:\Users\u\AppData\Local\Other.App\EBWebView" x"#
            ).map(|p| p.to_string_lossy().to_string().to_lowercase()),
            Some(UDF.to_lowercase())
        );
        // And a bare-substring mention inside an unrelated command line is not proof:
        // the exact --user-data-dir flag value is what is compared.
        assert_eq!(
            webview_user_data_dir("msedgewebview2.exe --other-flag=1 --user-data-dir=\"C:\\Users\\u\\AppData\\Local\\app.mkmn.desktop\\EBWebView\" --type=renderer"),
            Some(std::path::PathBuf::from(r#"C:\Users\u\AppData\Local\app.mkmn.desktop\EBWebView"#))
        );
    }

    /// Both quoted and unquoted --user-data-dir forms parse, and a command line
    /// without the flag yields None.
    #[test]
    fn user_data_dir_parsing_covers_both_forms() {
        assert_eq!(
            webview_user_data_dir(r#"x.exe --user-data-dir=C:\Temp\Plain --type=gpu"#),
            Some(std::path::PathBuf::from(r"C:\Temp\Plain"))
        );
        assert_eq!(webview_user_data_dir("x.exe --type=renderer"), None);
        assert_eq!(webview_user_data_dir(""), None);
    }

    /// The scan parser accepts prefixed rows, skips chatter, and joins multi-part
    /// command lines back together.
    #[test]
    fn scan_output_parses_candidates_and_table() {
        let us = '\u{1f}';
        let text = format!(
            "C{us}10{us}20{us}\"C:\\x\\msedgewebview2.exe\" --user-data-dir=\"{UDF}\" --type=renderer\r\n\
             P{us}20{us}10{us}msedgewebview2.exe\r\n\
             P{us}30{us}1{us}MKMN.exe\r\n\
             some noise line\r\n"
        );
        let (candidates, t) = parse_scan_output(&text).expect("parse");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].pid, 10);
        assert!(candidates[0].command_line.contains("--user-data-dir"));
        assert_eq!(t.len(), 2);
        assert_eq!(t.get(&30).expect("mkmn row").name, "MKMN.exe");
    }

    /// The webview this process itself owns (parent chain reaching THIS process) is
    /// a live-owner case — the scan can never kill its own browser, whatever the
    /// host process happens to be named.
    #[test]
    fn the_scan_never_kills_its_own_webview() {
        let me = std::process::id();
        // webview 10 → browser 20 → THIS process (the host): two hops, like reality.
        let t = table(&[proc(20, me, "msedgewebview2.exe"), proc(me, 1, "mkmn-test-host")]);
        let v = decide_stray_webviews(&[candidate(10, 20, "")], &t);
        assert_eq!(v[0].1, StrayVerdict::LeaveLiveOwner);
    }
}
