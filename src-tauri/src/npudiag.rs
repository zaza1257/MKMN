//! Native NPU counter diagnostics for the "Check the NPU counters" panel
//! (src/renderer/Benchmark.tsx). This replaces the former hard-coded placeholder in the
//! renderer bridge that always claimed `ok: true` with a fabricated adapter name.
//!
//! Everything here is measured on the PC the command runs on:
//! - the Windows build from the registry (whether that build ships NPU monitoring),
//! - the graphics/compute adapters in the DirectX registry, with their LUIDs,
//! - every counter set Windows has (so a PC without NPU counters shows what it does have),
//! - and a real two-sample PDH read of the engine/memory counters, attributed to the NPU
//!   by its adapter LUID: an adapter named for the NPU, or a compute-only adapter (one
//!   without a 3D engine), mirroring the implementation in src/core/perf.ts.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};

use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS};
use windows_sys::Win32::System::LibraryLoader::{LoadLibraryW, GetProcAddress};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, RegQueryInfoKeyW, HKEY,
    HKEY_LOCAL_MACHINE, KEY_READ, RRF_RT_REG_BINARY, RRF_RT_REG_DWORD, RRF_RT_REG_QWORD,
    RRF_RT_REG_SZ,
};

use crate::monitor::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W,
};

/// PdhEnumObjectsW is not exported by every import library in use, so it is resolved
/// from pdh.dll at run time (loaded on demand if the app has not touched PDH yet).
pub type PdhEnumObjectsWFn = unsafe extern "system" fn(
    sz_data_source: *const u16,
    sz_machine_name: *const u16,
    msz_object_list: *mut u16,
    pcch_buffer_length: *mut u32,
    dw_detail_level: u32,
    b_refresh: i32,
) -> u32;

fn pdh_enum_objects() -> Option<PdhEnumObjectsWFn> {
    unsafe {
        let module = LoadLibraryW(wide("pdh.dll").as_ptr());
        if module.is_null() {
            return None;
        }
        let addr = GetProcAddress(module, c"PdhEnumObjectsW".as_ptr().cast());
        addr.map(|a| std::mem::transmute::<unsafe extern "system" fn() -> isize, PdhEnumObjectsWFn>(a))
    }
}

/// What the "Check the NPU counters" panel shows: whether Windows exposes NPU counters
/// on this PC, and the values they read. Field names match src/shared/api.ts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NpuDiagnostics {
    pub ok: bool,
    pub problem: Option<String>,
    pub windows: Option<String>,
    #[serde(rename = "windowsHasNpuMonitoring")]
    pub windows_has_npu_monitoring: Option<bool>,
    pub sets: Vec<String>,
    pub adapter: Option<String>,
    pub adapters: Vec<String>,
    #[serde(rename = "topUtil")]
    pub top_util: Vec<String>,
    #[serde(rename = "allSets")]
    pub all_sets: Vec<String>,
    pub sample: Vec<String>,
    pub util: Option<f64>,
    #[serde(rename = "memGB")]
    pub mem_gb: Option<f64>,
}

// ============================================================================
// Registry reads
// ============================================================================

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn wide_to_string(buf: &[u16]) -> String {
    String::from_utf16_lossy(buf)
}

/// Read a REG_SZ value from a registry key (no aggregation prefix).
fn reg_read_string(key: HKEY, name: &str) -> Option<String> {
    let name_w = wide(name);
    let mut size: u32 = 0;
    let status = unsafe {
        RegGetValueW(key, std::ptr::null(), name_w.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), std::ptr::null_mut(), &mut size)
    };
    if status != ERROR_SUCCESS || size == 0 {
        return None;
    }
    let mut buf = vec![0u16; (size as usize) / 2];
    let status = unsafe {
        RegGetValueW(key, std::ptr::null(), name_w.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr() as *mut core::ffi::c_void, &mut size)
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let s = wide_to_string(&buf[..len]).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Read a REG_DWORD value from a registry key.
fn reg_read_dword(key: HKEY, name: &str) -> Option<u32> {
    let name_w = wide(name);
    let mut value: u32 = 0;
    let mut size: u32 = 4;
    let status = unsafe {
        RegGetValueW(key, std::ptr::null(), name_w.as_ptr(), RRF_RT_REG_DWORD, std::ptr::null_mut(), &mut value as *mut u32 as *mut core::ffi::c_void, &mut size)
    };
    if status != ERROR_SUCCESS { None } else { Some(value) }
}

/// The Windows build and update number ("26100.4061"), asked from the registry.
pub fn windows_build() -> Option<String> {
    let path = wide("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion");
    let mut key: HKEY = std::ptr::null_mut();
    let status = unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, path.as_ptr(), 0, KEY_READ, &mut key) };
    if status != ERROR_SUCCESS {
        return None;
    }
    let build = reg_read_string(key, "CurrentBuildNumber");
    let ubr = reg_read_dword(key, "UBR");
    unsafe { RegCloseKey(key) };
    build.map(|b| match ubr {
        Some(ubr) => format!("{}.{}", b, ubr),
        None => b,
    })
}

/// Microsoft's release notes put NPU monitoring in Task Manager (its counters) in
/// Windows 11 builds 26100.8524 (24H2), 26200.8524 (25H2) and 28000.2340 (26H1) and
/// later. None when the build is not one of those lines or cannot be read.
pub fn windows_has_npu_monitoring(build: Option<&str>) -> Option<bool> {
    let build = build?;
    let mut parts = build.trim().split('.');
    let major: u64 = parts.next()?.parse().ok()?;
    let minor: u64 = parts.next().unwrap_or("0").parse().ok()?;
    let need: [(u64, u64); 3] = [(26100, 8524), (26200, 8524), (28000, 2340)];
    for (m, min) in need {
        if major == m {
            return Some(minor >= min);
        }
    }
    if major > 28000 { Some(true) } else { None }
}

/// An adapter from the DirectX registry: its description and its LUID
/// ("luid_0x{high:08x}_0x{low:08x}", the form the PDH counter instances use).
pub struct DirectXAdapter {
    pub description: String,
    pub luid: String,
    /// The adapter's DriverVersion string from the registry, when present.
    pub driver_version: Option<String>,
}

fn luid_to_string(low: u32, high: i32) -> String {
    format!("luid_0x{:08X}_0x{:08X}", high as u32, low).to_lowercase()
}

/// Every graphics / compute adapter in the DirectX registry, with its LUID.
pub fn directx_adapters() -> Vec<DirectXAdapter> {
    let mut out = Vec::new();
    let path = wide("SOFTWARE\\Microsoft\\DirectX");
    let mut key: HKEY = std::ptr::null_mut();
    let status = unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, path.as_ptr(), 0, KEY_READ, &mut key) };
    if status != ERROR_SUCCESS {
        return out;
    }
    let mut subkeys: u32 = 0;
    let mut max_len: u32 = 0;
    if unsafe {
        RegQueryInfoKeyW(
            key, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), &mut subkeys,
            &mut max_len, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(),
            std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(),
        )
    } == ERROR_SUCCESS
    {
        for i in 0..subkeys {
            let mut name_buf = vec![0u16; max_len as usize + 1];
            let mut name_len: u32 = name_buf.len() as u32;
            let status = unsafe {
                RegEnumKeyExW(key, i, name_buf.as_mut_ptr(), &mut name_len, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut())
            };
            if status != ERROR_SUCCESS || name_len == 0 {
                continue;
            }
            let mut sub: HKEY = std::ptr::null_mut();
            if unsafe { RegOpenKeyExW(key, name_buf.as_ptr(), 0, KEY_READ, &mut sub) } != ERROR_SUCCESS {
                continue;
            }
            let description = reg_read_string(sub, "Description");
            // The driver version sits next to the description in the same key
            // (e.g. "31.0.2701.1000"); None when the key does not carry one.
            let driver_version = reg_read_string(sub, "DriverVersion");
            // AdapterLuid is a REG_QWORD (sometimes REG_BINARY): 8 bytes, little-endian,
            // low 4 bytes = LUID LowPart, high 4 bytes = LUID HighPart.
            let mut luid_bytes = [0u8; 8];
            let mut size: u32 = 8;
            let got_luid = unsafe {
                RegGetValueW(sub, std::ptr::null(), wide("AdapterLuid").as_ptr(), RRF_RT_REG_QWORD | RRF_RT_REG_BINARY, std::ptr::null_mut(), luid_bytes.as_mut_ptr() as *mut core::ffi::c_void, &mut size)
            } == ERROR_SUCCESS
                && size >= 8;
            unsafe { RegCloseKey(sub) };
            if let (Some(description), true) = (description, got_luid) {
                let low = u32::from_le_bytes(luid_bytes[0..4].try_into().unwrap());
                let high = i32::from_le_bytes(luid_bytes[4..8].try_into().unwrap());
                out.push(DirectXAdapter { description, luid: luid_to_string(low, high), driver_version });
            }
        }
    }
    unsafe { RegCloseKey(key) };
    out
}

// ============================================================================
// Counter sets
// ============================================================================

fn pdh_multi_sz(buf: Vec<u16>) -> Vec<String> {
    // A multi-sz list: names separated by NUL, terminated by an empty name.
    let mut names = Vec::new();
    let mut start = 0usize;
    while start < buf.len() {
        let end = buf[start..].iter().position(|&c| c == 0).map(|p| start + p).unwrap_or(buf.len());
        if end == start {
            break;
        }
        let name = wide_to_string(&buf[start..end]);
        if !name.is_empty() {
            names.push(name);
        }
        start = end + 1;
    }
    names
}

/// Every counter set Windows has, by name: when no NPU set is found this shows what is
/// there instead, for the diagnostics.
pub fn enumerate_counter_sets() -> Vec<String> {
    let Some(enum_objects) = pdh_enum_objects() else {
        return Vec::new();
    };
    let mut size: u32 = 0;
    // PERF_DETAIL_WIZARD = 4: every counter set, not only the wizard-visible ones.
    unsafe { enum_objects(std::ptr::null(), std::ptr::null(), std::ptr::null_mut(), &mut size, 4, 1) };
    if size == 0 {
        return Vec::new();
    }
    let mut buf = vec![0u16; size as usize];
    let status = unsafe { enum_objects(std::ptr::null(), std::ptr::null(), buf.as_mut_ptr(), &mut size, 4, 1) };
    if status != ERROR_SUCCESS && status != ERROR_MORE_DATA {
        return Vec::new();
    }
    let mut sets: BTreeSet<String> = pdh_multi_sz(buf).into_iter().collect();
    sets.remove("");
    sets.into_iter().collect()
}

// ============================================================================
// Sampling
// ============================================================================

/// One formatted counter value: the counter's instance name and its value.
pub struct CounterValue {
    pub instance: String,
    pub value: f64,
}

/// Read every instance of one counter, sized in two calls (PDH_MORE_DATA pattern).
fn read_counter(counter: isize) -> Vec<CounterValue> {
    const PDH_FMT_DOUBLE: u32 = 0x00000200;
    const PDH_MORE_DATA: u32 = 0x800007D2;
    let mut buffer_size: u32 = 0;
    let mut item_count: u32 = 0;
    let res = unsafe {
        PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut buffer_size, &mut item_count, std::ptr::null_mut())
    };
    if (res != 0 && res != PDH_MORE_DATA) || buffer_size == 0 {
        return Vec::new();
    }
    let mut buffer = vec![0u8; buffer_size as usize];
    let res = unsafe {
        PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut buffer_size, &mut item_count, buffer.as_mut_ptr())
    };
    if res != 0 || item_count == 0 {
        return Vec::new();
    }
    let items = unsafe {
        std::slice::from_raw_parts(buffer.as_ptr() as *const PDH_FMT_COUNTERVALUE_ITEM_W, item_count as usize)
    };
    let mut out = Vec::with_capacity(item_count as usize);
    for item in items {
        if item.sz_name.is_null() {
            continue;
        }
        let mut len = 0usize;
        while unsafe { *item.sz_name.add(len) } != 0 {
            len += 1;
        }
        out.push(CounterValue {
            instance: wide_to_string(unsafe { std::slice::from_raw_parts(item.sz_name, len) }),
            value: item.fmt_value.double_value,
        });
    }
    out
}

fn open_counter(query: isize, path: &str) -> Option<isize> {
    let mut counter: isize = 0;
    let status = unsafe { PdhAddEnglishCounterW(query, wide(path).as_ptr(), 0, &mut counter) };
    if status != 0 || counter == 0 { None } else { Some(counter) }
}

/// The parts of a GPU Engine instance name: pid (when the instance names a process),
/// the adapter LUID, and the engine type ("3D", "NPU", "VideoDecode", ...).
pub struct EngineInstance {
    pub pid: Option<u32>,
    pub luid: String,
    pub engtype: String,
}

/// "pid_4216_luid_0x00000000_0x00010c23_engtype_3D" -> its parts. Instance names are
/// language-neutral, so this works on every Windows language.
pub fn parse_engine_instance(name: &str) -> Option<EngineInstance> {
    let lower = name.to_lowercase();
    let luid_start = lower.find("luid_0x")?;
    // the LUID keeps its two underscores: luid_0x00000000_0x00010c23
    let luid: String = lower[luid_start..].split('_').take(3).collect::<Vec<_>>().join("_");
    let pid = {
        let mut parsed = None;
        if let Some(pos) = lower.find("pid_") {
            let rest = &lower[pos + 4..];
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if !digits.is_empty() {
                parsed = digits.parse::<u32>().ok();
            }
        }
        parsed
    };
    let engtype = {
        match lower.find("engtype_") {
            Some(pos) => {
                let rest = &lower[pos + 8..];
                let end = rest.find('_').unwrap_or(rest.len());
                rest[..end].to_string()
            }
            None => String::new(),
        }
    };
    Some(EngineInstance { pid, luid, engtype })
}

const NPU_ADAPTER_RE: &[&str] = &["npu", "hexagon", "neural", "ai boost", "compute"];

pub fn looks_like_npu(description: &str) -> bool {
    let lower = description.to_lowercase();
    NPU_ADAPTER_RE.iter().any(|w| lower.contains(w))
}

/// Which adapter LUIDs belong to the NPU: an adapter named for the NPU, or — when none
/// is — every compute-only adapter (one that has engine counters but no 3D engine; a GPU
/// always has a 3D engine, an NPU only computes).
fn npu_luids(engine_values: &[CounterValue], adapters: &[DirectXAdapter]) -> (Vec<String>, Option<String>) {
    let named: Vec<(String, String)> = adapters.iter()
        .filter(|a| looks_like_npu(&a.description))
        .map(|a| (a.luid.clone(), a.description.clone()))
        .collect();
    if !named.is_empty() {
        return (named.iter().map(|(l, _)| l.clone()).collect(), Some(named.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>().join(", ")));
    }
    // Fallback: compute-only adapters among the engine instances.
    let mut has_3d: HashSet<String> = HashSet::new();
    let mut all_luids: HashSet<String> = HashSet::new();
    for v in engine_values {
        if let Some(e) = parse_engine_instance(&v.instance) {
            all_luids.insert(e.luid.clone());
            if e.engtype == "3d" {
                has_3d.insert(e.luid);
            }
        }
    }
    let compute_only: Vec<String> = all_luids.difference(&has_3d).cloned().collect();
    let name = if compute_only.is_empty() { None } else { Some("compute-only adapter".to_string()) };
    (compute_only, name)
}

/// The result of one live PDH sample, before the summary is assembled.
pub struct NpuSample {
    pub active_npu_processes: Vec<(u32, f64)>,
    pub sets: Vec<String>,
    pub adapter: Option<String>,
    pub top_util: Vec<String>,
    pub sample: Vec<String>,
    pub util: Option<f64>,
    pub mem_bytes: Option<u64>,
}

/// Sample the NPU's load and memory twice (a percentage needs two samples) and attribute
/// the values to the NPU by its adapter LUID.
pub fn sample_npu() -> NpuSample {
    let mut query: isize = 0;
    if unsafe { PdhOpenQueryW(std::ptr::null(), 0, &mut query) } != 0 || query == 0 {
        return NpuSample { active_npu_processes: Vec::new(), sets: Vec::new(), adapter: None, top_util: Vec::new(), sample: Vec::new(), util: None, mem_bytes: None };
    }

    let engine_counter = open_counter(query, "\\GPU Engine(*)\\Utilization Percentage");
    let dedicated_counter = open_counter(query, "\\GPU Adapter Memory(*)\\Dedicated Usage");
    let shared_counter = open_counter(query, "\\GPU Adapter Memory(*)\\Shared Usage");

    unsafe { PdhCollectQueryData(query) };
    std::thread::sleep(std::time::Duration::from_millis(300));
    unsafe { PdhCollectQueryData(query) };

    let engine_values = engine_counter.map(read_counter).unwrap_or_default();
    let dedicated = dedicated_counter.map(read_counter).unwrap_or_default();
    let shared = shared_counter.map(read_counter).unwrap_or_default();
    unsafe { PdhCloseQuery(query) };

    let adapters = directx_adapters();
    let (npu_luids, adapter_name) = npu_luids(&engine_values, &adapters);
    let npu_set: HashSet<&str> = npu_luids.iter().map(|s| s.as_str()).collect();

    // Like Task Manager: the load of the NPU is that of its busiest engine, each
    // engine's load being the sum over the processes using it.
    let mut engines: HashMap<String, f64> = HashMap::new();
    let mut raw_util: Vec<(String, f64)> = Vec::new();
    let mut active_npu_processes = Vec::new();
    for v in &engine_values {
        let Some(e) = parse_engine_instance(&v.instance) else { continue };
        if !(0.0..=100.5).contains(&v.value) {
            continue; // a percentage cannot be above 100: a first sample, not a load
        }
        // Warn about PIDs only with explicit NPU engine/adapter evidence. A
        // compute-only adapter is a useful diagnostic hint but might be a GPU.
        if let Some(pid) = e.pid
            && (matches!(e.engtype.as_str(), "npu" | "neural")
                || adapters.iter().any(|adapter| adapter.luid == e.luid
                    && ["npu", "hexagon", "neural", "ai boost"].iter()
                        .any(|name| adapter.description.to_ascii_lowercase().contains(name))))
        {
            active_npu_processes.push((pid, v.value));
        }
        if !npu_set.contains(e.luid.as_str()) {
            continue;
        }
        raw_util.push((v.instance.clone(), v.value));
        // one key per adapter LUID and engine type, so two NPUs never share a key
        let engine_key = format!("{}_{}", e.luid, e.engtype);
        *engines.entry(engine_key).or_insert(0.0) += v.value;
    }

    let util = if engines.is_empty() {
        None
    } else {
        Some((engines.values().cloned().fold(0.0f64, f64::max)).round().clamp(0.0, 100.0))
    };

    // Memory in use on the NPU: dedicated plus shared adapter memory of its LUID.
    let mut mem_bytes: u64 = 0;
    let mut saw_mem = false;
    for values in [&dedicated, &shared] {
        for v in values {
            let lower = v.instance.to_lowercase();
            if !npu_set.iter().any(|l| lower.contains(l)) {
                continue;
            }
            if v.value > 0.0 {
                mem_bytes += v.value as u64;
                saw_mem = true;
            }
        }
    }

    let mut top_util: Vec<String> = raw_util.iter().map(|(p, v)| format!("{} = {}", p, v)).collect();
    top_util.sort_by(|a, b| {
        let va: f64 = a.rsplit(" = ").next().and_then(|s| s.trim().parse().ok()).unwrap_or(0.0);
        let vb: f64 = b.rsplit(" = ").next().and_then(|s| s.trim().parse().ok()).unwrap_or(0.0);
        vb.partial_cmp(&va).unwrap_or(std::cmp::Ordering::Equal)
    });
    top_util.truncate(6);

    let mut sample: Vec<String> = Vec::new();
    for (instance, value) in engine_values.iter().map(|v| (&v.instance, v.value))
        .chain(dedicated.iter().map(|v| (&v.instance, v.value)))
        .chain(shared.iter().map(|v| (&v.instance, v.value)))
    {
        if npu_set.iter().any(|l| instance.to_lowercase().contains(l)) {
            sample.push(format!("{} = {}", instance, value));
        }
    }
    sample.truncate(24);

    let sets = if npu_luids.is_empty() {
        Vec::new()
    } else {
        vec!["GPU Engine".to_string(), "GPU Adapter Memory".to_string()]
    };

    NpuSample {
        active_npu_processes,
        sets,
        adapter: adapter_name,
        top_util,
        sample,
        util,
        mem_bytes: if saw_mem { Some(mem_bytes) } else { None },
    }
}

/// What the sample could not find, in words, for the diagnostics.
fn npu_problem(sample: &NpuSample) -> Option<String> {
    if sample.sets.is_empty() && sample.util.is_none() && sample.mem_bytes.is_none() {
        return Some("Windows has no performance counters for the NPU on this PC: no counter set with NPU in its name, and no compute-only adapter among the GPU counters. Updating Windows and the NPU driver may add them (Task Manager's NPU tab needs them too).".to_string());
    }
    if sample.util.is_none() && sample.mem_bytes.is_none() {
        return Some("The NPU counters exist but returned no values.".to_string());
    }
    None
}

/// Collect the full diagnostics panel payload, measured on this PC.
pub fn collect() -> NpuDiagnostics {
    let windows = windows_build();
    let has_monitoring = windows_has_npu_monitoring(windows.as_deref());
    let all_sets = enumerate_counter_sets();
    let npu_named_sets: Vec<String> = all_sets.iter()
        .filter(|s| {
            let lower = s.to_lowercase();
            ["npu", "neural", "hexagon"].iter().any(|w| lower.contains(w))
        })
        .cloned()
        .collect();
    let sample = sample_npu();

    // The dedicated NPU counter sets Windows has (by name), when it has them; otherwise
    // the GPU sets the NPU's numbers were read from.
    let sets = if !npu_named_sets.is_empty() { npu_named_sets } else { sample.sets.clone() };
    let problem = npu_problem(&sample);
    let mem_gb = sample.mem_bytes.map(|b| ((b as f64 / 1024.0 / 1024.0 / 1024.0) * 100.0).round() / 100.0);

    NpuDiagnostics {
        ok: problem.is_none(),
        problem,
        windows,
        windows_has_npu_monitoring: has_monitoring,
        sets,
        adapter: sample.adapter.clone(),
        adapters: adapters_list(&sample),
        top_util: sample.top_util.clone(),
        all_sets,
        sample: sample.sample.clone(),
        util: sample.util,
        mem_gb,
    }
}

fn adapters_list(_sample: &NpuSample) -> Vec<String> {
    directx_adapters().iter()
        .map(|a| format!("{} {}", a.description, a.luid))
        .collect()
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_windows_has_npu_monitoring_thresholds() {
        assert_eq!(windows_has_npu_monitoring(Some("26100.4061")), Some(false));
        assert_eq!(windows_has_npu_monitoring(Some("26100.8524")), Some(true));
        assert_eq!(windows_has_npu_monitoring(Some("26200.8524")), Some(true));
        assert_eq!(windows_has_npu_monitoring(Some("28000.2340")), Some(true));
        assert_eq!(windows_has_npu_monitoring(Some("28000.1000")), Some(false));
        assert_eq!(windows_has_npu_monitoring(Some("28100.1")), Some(true));
        assert_eq!(windows_has_npu_monitoring(Some("22631.1")), None);
        assert_eq!(windows_has_npu_monitoring(None), None);
        assert_eq!(windows_has_npu_monitoring(Some("garbage")), None);
    }

    #[test]
    fn test_parse_engine_instance() {
        let e = parse_engine_instance("pid_4216_luid_0x00000000_0x00010C23_engtype_3D").unwrap();
        assert_eq!(e.pid, Some(4216));
        assert_eq!(e.luid, "luid_0x00000000_0x00010c23");
        assert_eq!(e.engtype, "3d");

        let e = parse_engine_instance("luid_0x00000000_0x00010ee8_engtype_NPU").unwrap();
        assert_eq!(e.pid, None);
        assert_eq!(e.luid, "luid_0x00000000_0x00010ee8");
        assert_eq!(e.engtype, "npu");

        // an instance with a trailing phys suffix still parses
        let e = parse_engine_instance("pid_9_luid_0x00000000_0x00010c23_engtype_VideoDecode_phys_0").unwrap();
        assert_eq!(e.pid, Some(9));
        assert_eq!(e.engtype, "videodecode");

        assert!(parse_engine_instance("no counters here").is_none());
    }

    #[test]
    fn test_npu_luid_discovery() {
        let adapters = vec![
            DirectXAdapter { description: "Qualcomm(R) Adreno(TM) X2-90 GPU".into(), luid: "luid_0x00000000_0x00010c23".into(), driver_version: None },
            DirectXAdapter { description: "Hexagon NPU".into(), luid: "luid_0x00000000_0x00010ee8".into(), driver_version: None },
        ];
        let engines: Vec<CounterValue> = vec![
            CounterValue { instance: "pid_1_luid_0x00000000_0x00010c23_engtype_3D".into(), value: 5.0 },
            CounterValue { instance: "pid_2_luid_0x00000000_0x00010ee8_engtype_NPU".into(), value: 42.0 },
        ];
        let (luids, name) = npu_luids(&engines, &adapters);
        assert_eq!(luids, vec!["luid_0x00000000_0x00010ee8".to_string()]);
        assert_eq!(name.as_deref(), Some("Hexagon NPU"));
    }

    #[test]
    fn test_compute_only_fallback_discovery() {
        // No NPU-named adapter: the LUID that has no 3D engine is the compute adapter.
        let adapters = vec![
            DirectXAdapter { description: "Some GPU".into(), luid: "luid_0x00000000_0x00000001".into(), driver_version: None },
        ];
        let engines: Vec<CounterValue> = vec![
            CounterValue { instance: "pid_1_luid_0x00000000_0x00000001_engtype_3D".into(), value: 5.0 },
            CounterValue { instance: "pid_2_luid_0x00000000_0x00000002_engtype_NPU".into(), value: 42.0 },
        ];
        let (luids, name) = npu_luids(&engines, &adapters);
        assert_eq!(luids, vec!["luid_0x00000000_0x00000002".to_string()]);
        assert_eq!(name.as_deref(), Some("compute-only adapter"));
    }

    #[test]
    fn test_pdh_multi_sz() {
        let buf: Vec<u16> = "GPU Engine\0GPU Adapter Memory\0".encode_utf16().chain(std::iter::once(0)).collect();
        let names = pdh_multi_sz(buf);
        assert_eq!(names, vec!["GPU Engine", "GPU Adapter Memory"]);
    }

    #[test]
    fn test_npu_problem_messages() {
        let none = NpuSample { active_npu_processes: Vec::new(), sets: Vec::new(), adapter: None, top_util: Vec::new(), sample: Vec::new(), util: None, mem_bytes: None };
        let problem = npu_problem(&none).unwrap();
        assert!(problem.contains("no performance counters for the NPU"));

        let empty = NpuSample { active_npu_processes: Vec::new(), sets: vec!["NPU Engine".into()], adapter: None, top_util: Vec::new(), sample: Vec::new(), util: None, mem_bytes: None };
        let problem = npu_problem(&empty).unwrap();
        assert!(problem.contains("returned no values"));

        let good = NpuSample { active_npu_processes: Vec::new(), sets: vec!["NPU Engine".into()], adapter: Some("Hexagon NPU".into()), top_util: Vec::new(), sample: Vec::new(), util: Some(42.0), mem_bytes: Some(1024) };
        assert!(npu_problem(&good).is_none());
    }

    /// The live command must run on this PC and answer consistently, whatever counters
    /// it finds. On a PC without NPU counters it must say so, not invent values.
    #[test]
    fn test_collect_live_is_consistent() {
        let d = collect();
        if d.ok {
            assert!(d.problem.is_none());
            assert!(d.util.is_some() || d.mem_gb.is_some(), "ok=true requires at least one measured value");
            assert!(!d.sets.is_empty());
        } else {
            assert!(d.problem.is_some());
            assert!(d.util.is_none() && d.mem_gb.is_none(), "a failed diagnosis must not invent values");
        }
        assert!(d.mem_gb.map(|g| g >= 0.0).unwrap_or(true));
        assert!(d.util.map(|u| (0.0..=100.0).contains(&u)).unwrap_or(true));
        assert!(d.sample.len() <= 24);
        assert!(d.top_util.len() <= 6);
        for a in &d.adapters {
            assert!(a.contains("luid_0x"), "adapter entries carry their LUID: {}", a);
        }
        let mut sorted = d.all_sets.clone();
        sorted.sort();
        assert_eq!(sorted, d.all_sets, "allSets is sorted");
    }
}
