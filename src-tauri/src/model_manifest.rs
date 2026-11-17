//! The model artifact manifest and the per-device evidence store.
//!
//! **Manifest (objective: canonical artifact identity).** Every artifact in the GenieX
//! cache carries its own metadata: `geniex.json` (identity, plugin/runtime, precision,
//! vision projector) and, for QAIRT bundles, `metadata.json` (chipset requirements,
//! compiled context lengths, thinking support, the toolchain the graph was compiled
//! with) plus `genie_config.json` (compiled dialog context). Scanning those files —
//! NOT model names — is what makes capability claims checkable: a bundle's
//! `chipset_attributes` either names this chipset or it does not. There are **no
//! checksums** in the cache layout, so the revision is the honest surrogate: total
//! bytes on disk plus the newest file mtime. Anything that needs to detect "the
//! artifact changed" compares against `totalBytes`/`revision`, never against the name.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use windows_sys::Win32::Foundation::CloseHandle;

use crate::memory_estimator::qairt_compiled_context;
use crate::paths::{get_config_dir, get_geniex_models_dirs};

// ---------------------------------------------------------------------------
// Artifact manifest
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFile {
    pub name: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactManifestEntry {
    /// Canonical cache identity, e.g. `qualcomm/Qwen3-4B` (no precision — the
    /// precision is its own field, and a bundle can carry several builds).
    pub r#ref: String,
    /// The runtime plugin the cache says runs it: `qairt` or `llama_cpp`.
    pub plugin: String,
    /// What the cache says the artifact is: `llm`, `vlm`, … — modality evidence,
    /// never inferred from the name.
    pub model_type: Option<String>,
    /// The precision builds present in the cache (`W4A16`, `Q4_0`, …).
    pub precisions: Vec<String>,
    /// The vision projector file when the artifact carries one.
    pub mmproj_file: Option<String>,
    /// Bytes actually on disk, measured by walking the artifact directory.
    pub total_bytes: u64,
    /// Newest file mtime in the artifact directory (epoch ms): the revision
    /// surrogate. The cache layout has no checksums; size+mtime is what we have.
    pub revision: Option<u64>,
    /// The context a QAIRT graph was COMPILED with (None for GGUF: configurable).
    pub compiled_context: Option<u32>,
    /// Every context length the bundle declares (QAIRT metadata / genie config).
    pub context_lengths: Vec<u32>,
    /// Whether the bundle itself declares thinking support (None: not declared).
    pub supports_thinking: Option<bool>,
    /// The chipsets the bundle declares support for (`chipset_attributes`).
    pub chipset: Option<serde_json::Value>,
    /// The toolchain versions the artifact was built with (`tool_versions`).
    pub compile_tool_versions: Option<serde_json::Value>,
    /// The declared use case (e.g. "Text Generation").
    pub use_case: Option<String>,
}

/// Size of every file under `dir` (recursive, hidden/lock files skipped) and the
/// newest mtime. Returns (total_bytes, newest_mtime_ms).
fn dir_size_and_revision(dir: &Path) -> (u64, Option<u64>, bool) {
    let mut total: u64 = 0;
    let mut newest: Option<u64> = None;
    // A weights file is what makes a directory a MODEL, not its metadata: GGUF
    // shards end in .gguf, QAIRT bundles carry .serialized graphs (and .dlc
    // companions). A directory of only json/registry files is not an artifact.
    let mut has_weights = false;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = fs::read_dir(&d) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name.ends_with(".progress") {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(meta) = path.metadata()
                && meta.is_file() {
                    total += meta.len();
                    let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase());
                    if matches!(ext.as_deref(), Some("gguf") | Some("serialized") | Some("dlc") | Some("bin")) {
                        has_weights = true;
                    }
                    if let Ok(modified) = meta.modified()
                        && let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
                            let ms = dur.as_millis() as u64;
                            if newest.map(|n| ms > n).unwrap_or(true) {
                                newest = Some(ms);
                            }
                        }
                }
        }
    }
    (total, newest, has_weights)
}

/// Reads one artifact directory (an `org/name` folder inside the models cache).
#[allow(clippy::too_many_lines)]
/// The precision a QAIRT bundle's `metadata.json` declares, as GenieX names it in a model
/// ref (`W4A16`). GenieX 0.11.0 (#1664) reads two layouts: the legacy one writes `"w4a16"`,
/// the new one (with a `model_files` array) writes `"PRECISION_W4A16"`; its prefix is not
/// part of the name.
pub(crate) fn metadata_precision(meta: &serde_json::Value) -> Option<String> {
    let raw = meta.get("precision")?.as_str()?.trim();
    let upper = raw.to_uppercase();
    let name = upper.strip_prefix("PRECISION_").unwrap_or(&upper);
    (!name.is_empty()).then(|| name.to_string())
}

fn scan_artifact_dir(dir: &Path, owner_ref: &str) -> Option<ArtifactManifestEntry> {
    // The cache's own registry: identity, plugin, precision, projector, modality.
    let registry: serde_json::Value = fs::read_to_string(dir.join("geniex.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(serde_json::Value::Null);

    let name_of = |v: &serde_json::Value| -> Option<String> {
        v.get("Name").and_then(serde_json::Value::as_str).filter(|s| !s.is_empty()).map(|s| s.to_string())
    };

    let plugin = registry
        .get("PluginId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_else(|| if dir.join("genie_config.json").exists() { "qairt" } else { "llama_cpp" })
        .to_string();
    let model_type = registry
        .get("ModelType")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    // Precision builds: the keys of ModelFile that are actually downloaded.
    let mut precisions: Vec<String> = Vec::new();
    if let Some(files) = registry.get("ModelFile").and_then(serde_json::Value::as_object) {
        for (precision, build) in files {
            if build.get("Downloaded").and_then(serde_json::Value::as_bool).unwrap_or(false) {
                precisions.push(precision.clone());
            }
        }
    }
    precisions.sort();
    if precisions.is_empty() && plugin == "qairt" {
        // A bundle without the registry still has a precision in its metadata.json.
        if let Ok(text) = fs::read_to_string(dir.join("metadata.json"))
            && let Ok(v) = serde_json::from_str::<serde_json::Value>(&text)
                && let Some(p) = metadata_precision(&v) {
                    precisions.push(p);
                }
    }

    let mmproj_file = registry.get("MMProjFile").and_then(name_of).filter(|_| {
        registry
            .get("MMProjFile")
            .and_then(|m| m.get("Downloaded"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    });

    let (total_bytes, revision, has_weights) = dir_size_and_revision(dir);
    if total_bytes == 0 || !has_weights {
        // An empty, partial or metadata-only directory is not an artifact: a
        // download that never wrote weights must not appear installed, and a
        // "files present" badge must not stand on registry JSON alone.
        return None;
    }

    // QAIRT metadata: context, thinking, chipset, toolchain, use case.
    let meta: serde_json::Value = fs::read_to_string(dir.join("metadata.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(serde_json::Value::Null);
    let mut context_lengths: Vec<u32> = meta
        .get("genie")
        .and_then(|g| g.get("context_lengths"))
        .and_then(serde_json::Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as u32)).collect())
        .unwrap_or_default();
    let supports_thinking = meta
        .get("genie")
        .and_then(|g| g.get("supports_thinking"))
        .and_then(serde_json::Value::as_bool);
    let compiled_context = qairt_compiled_context(owner_ref);
    if let Some(ctx) = compiled_context
        && !context_lengths.contains(&ctx) {
            context_lengths.push(ctx);
            context_lengths.sort_unstable();
        }

    Some(ArtifactManifestEntry {
        r#ref: owner_ref.to_string(),
        plugin,
        model_type,
        precisions,
        mmproj_file,
        total_bytes,
        revision,
        compiled_context,
        context_lengths,
        supports_thinking,
        chipset: meta.get("chipset_attributes").cloned().filter(|v| !v.is_null()),
        compile_tool_versions: meta.get("tool_versions").cloned().filter(|v| !v.is_null()),
        use_case: meta
            .get("use_case")
            .and_then(serde_json::Value::as_str)
            .map(|s| s.to_string()),
    })
}

/// Scans every GenieX model cache directory into the artifact manifest. A missing
/// cache yields an empty manifest, never an error: the UI must render "nothing
/// installed", not fail.
pub fn scan_model_manifest() -> Vec<ArtifactManifestEntry> {
    let mut out: Vec<ArtifactManifestEntry> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for models_dir in get_geniex_models_dirs() {
        let Ok(orgs) = fs::read_dir(&models_dir) else { continue };
        for org in orgs.flatten() {
            if !org.path().is_dir() {
                continue;
            }
            let org_name = org.file_name().to_string_lossy().to_string();
            let Ok(names) = fs::read_dir(org.path()) else { continue };
            for name in names.flatten() {
                if !name.path().is_dir() {
                    continue;
                }
                let name_str = name.file_name().to_string_lossy().to_string();
                let owner_ref = format!("{org_name}/{name_str}");
                if !seen.insert(owner_ref.clone()) {
                    continue;
                }
                if let Some(entry) = scan_artifact_dir(&name.path(), &owner_ref) {
                    out.push(entry);
                }
            }
        }
    }
    out.sort_by(|a, b| a.r#ref.cmp(&b.r#ref));
    out
}

// ---------------------------------------------------------------------------
// Per-device evidence store
// ---------------------------------------------------------------------------

/// The five evidence kinds, from vague to specific. A badge exists ONLY with a
/// matching record; "tested"/"verified" as free-floating words are gone.
pub const EVIDENCE_KINDS: [&str; 5] = [
    "download-verified",
    "compatible-metadata",
    "loaded-on-device",
    "quality-evaluated",
    "performance-measured",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceRecord {
    /// Upsert key: `{kind}:{ref}` (optionally suffixed for suites, e.g.
    /// `quality-evaluated:tournament:qualcomm/Qwen3-4B:W4A16`).
    pub id: String,
    /// One of `EVIDENCE_KINDS`.
    pub kind: String,
    /// The canonical artifact ref the evidence is about.
    pub r#ref: String,
    /// RFC3339 timestamp of when the evidence was produced.
    pub as_of: String,
    /// Machine fingerprint the evidence was produced on (CPU/RAM summary or an
    /// explicit label). Evidence from another machine stays, but reads as stale here.
    pub machine: String,
    /// Runtime version the evidence was produced with (GenieX/QAIRT versions).
    pub runtime_version: String,
    /// The configuration the evidence was produced under (context, compute, settings).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<serde_json::Value>,
    /// The measured result (score, tok/s, placement, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
}

pub fn evidence_path() -> std::path::PathBuf {
    get_config_dir().join("model-evidence.json")
}

/// Loads every evidence record; a missing or unreadable file is an empty store.
pub fn load_evidence() -> Vec<EvidenceRecord> {
    load_evidence_from(&evidence_path())
}

pub fn load_evidence_from(path: &Path) -> Vec<EvidenceRecord> {
    let Ok(text) = fs::read_to_string(path) else { return Vec::new() };
    serde_json::from_str::<Vec<EvidenceRecord>>(&text).unwrap_or_default()
}

/// Upserts records by id, validating the kind. Unknown kinds are rejected with a
/// reason: a badge that is not one of the five named kinds does not exist.
pub fn upsert_evidence(records: &[EvidenceRecord]) -> Result<Vec<EvidenceRecord>, String> {
    upsert_evidence_into(&evidence_path(), records)
}

/// The evidence store's single-writer lock: the read-modify-write below must be
/// serialized, or two concurrent upserts (sidecar measurement + benchmark, say)
/// each read the old store and the second write erases the first's record.
static EVIDENCE_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// FNV-1a 64-bit: a stable, dependency-free file-path hash for the mutex name.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Cross-process single-writer lock over ONE evidence file (C06): the in-process
/// mutex above cannot see another process's writer (the sidecar upserting a
/// measurement while the host benchmarks), so the read-modify-write takes a named
/// Windows mutex whose name is derived from the file path (FNV-1a, `Local\`
/// namespace = this session). When the mutex cannot be created or acquired, the
/// write degrades to the in-process lock alone rather than failing: the rename
/// retry below still narrows the lost-update window.
struct CrossProcessFileLock {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

impl CrossProcessFileLock {
    fn acquire(path: &Path) -> Option<Self> {
        use windows_sys::Win32::Foundation::{INVALID_HANDLE_VALUE, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{
            CreateMutexW, WaitForSingleObject, INFINITE,
        };
        let name = format!(
            "Local\\MKMN-evidence-{:016x}\0",
            fnv1a(path.to_string_lossy().as_bytes())
        );
        let wide: Vec<u16> = name.encode_utf16().collect();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return None;
        }
        if unsafe { WaitForSingleObject(handle, INFINITE) } != WAIT_OBJECT_0 {
            unsafe { CloseHandle(handle) };
            return None;
        }
        Some(Self { handle })
    }
}

impl Drop for CrossProcessFileLock {
    fn drop(&mut self) {
        use windows_sys::Win32::System::Threading::ReleaseMutex;
        unsafe {
            ReleaseMutex(self.handle);
            CloseHandle(self.handle);
        }
    }
}

pub fn upsert_evidence_into(path: &Path, records: &[EvidenceRecord]) -> Result<Vec<EvidenceRecord>, String> {
    // A poisoned lock only means a writer panicked mid-write; the store itself is
    // per-record JSON, so continuing is safe.
    let _guard = EVIDENCE_WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    // The OTHER processes' writers (C06).
    let _cross_process = CrossProcessFileLock::acquire(path);
    let mut all = load_evidence_from(path);
    for record in records {
        if record.id.trim().is_empty() {
            return Err("Evidence record without an id.".to_string());
        }
        if !EVIDENCE_KINDS.contains(&record.kind.as_str()) {
            return Err(format!(
                "Unknown evidence kind '{}'. Kinds are: {}.",
                record.kind,
                EVIDENCE_KINDS.join(", ")
            ));
        }
        if record.r#ref.trim().is_empty() {
            return Err("Evidence record without an artifact ref.".to_string());
        }
        if record.as_of.trim().is_empty() {
            return Err("Evidence record without a timestamp.".to_string());
        }
        match all.iter_mut().find(|r| r.id == record.id) {
            Some(existing) => *existing = record.clone(),
            None => all.push(record.clone()),
        }
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let serialized = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
    // A unique staging name (pid + write nanos): two writers must never collide on
    // one temp file, and the rename below replaces atomically.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!("json.{}.{}.tmp", std::process::id(), nanos));
    fs::write(&tmp, &serialized).map_err(|e| format!("Failed to write evidence: {e}"))?;
    // A rename can lose to a sharing violation when another process still holds
    // the destination open for reading (an AV scan, the UI refreshing): retry a
    // few times before the direct-write fallback, which is the non-atomic last
    // resort, never the plan.
    let mut renamed = false;
    for _ in 0..5 {
        if fs::rename(&tmp, path).is_ok() {
            renamed = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    if !renamed {
        let _ = fs::remove_file(&tmp);
        fs::write(path, &serialized).map_err(|e| format!("Failed to write evidence: {e}"))?;
    }
    Ok(all)
}

/// Fills in the immutable artifact identity (size, revision surrogate) from the
/// cache scan when a record does not carry it: evidence produced "for a ref"
/// must stay comparable against the artifact it actually measured, and the
/// freshness check needs the revision the UI never sees otherwise.
pub(crate) fn enrich_with_artifact_identity(records: &mut [EvidenceRecord]) {
    if records.is_empty() {
        return;
    }
    let manifest = scan_model_manifest();
    for record in records.iter_mut() {
        // The manifest's ref is the repository-level identity; a record may name a
        // precision (GGUF) or the catalog's namespace spelling. Compare bases.
        let want = artifact_base_ref(&record.r#ref);
        let entry = manifest.iter().find(|m| artifact_base_ref(&m.r#ref) == want);
        let Some(entry) = entry else { continue };
        let result = record.result.get_or_insert_with(|| serde_json::Value::Object(Default::default()));
        if !result.is_object() {
            continue; // a non-object result (a plain score, say) is left alone
        }
        let obj = result.as_object_mut().unwrap();
        obj.entry("totalBytes".to_string())
            .or_insert(serde_json::Value::from(entry.total_bytes));
        if let Some(rev) = entry.revision {
            obj.entry("revision".to_string())
                .or_insert(serde_json::Value::from(rev));
        }
    }
}

/// The repository-level identity of a ref: namespace spelling normalized, the
/// precision suffix and a trailing `-gguf` on the repo name dropped.
fn artifact_base_ref(s: &str) -> String {
    let lowered = s.trim().to_lowercase().replace("ai-hub-models/", "qualcomm/");
    let base = lowered.split(':').next().unwrap_or(&lowered);
    base.strip_suffix("-gguf").unwrap_or(base).to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::get_geniex_models_dirs;

    /// GenieX #1664 (0.11.0) reads two metadata.json layouts; these are its own test fixtures.
    /// The new one writes the precision as `PRECISION_W4A16`, which became the precision
    /// "PRECISION_W4A16" here (only upper-cased), so the bundle's GenieX name was wrong.
    #[test]
    fn metadata_precision_reads_the_legacy_and_the_new_layout() {
        let legacy = serde_json::json!({"precision": "w4a16", "genie": {"supports_vision": true}});
        let new = serde_json::json!({"precision": "PRECISION_W4A16", "model_files": [{"filename": "part1_of_1.bin"}], "genie": {"supports_vision": true}});
        assert_eq!(metadata_precision(&legacy).as_deref(), Some("W4A16"));
        assert_eq!(metadata_precision(&new).as_deref(), Some("W4A16"));
        assert_eq!(metadata_precision(&serde_json::json!({"genie": {"supports_streaming": true}})), None);
        assert_eq!(metadata_precision(&serde_json::json!({"precision": "PRECISION_"})), None);
    }

    /// The manifest is built from the REAL cache when one exists on this machine:
    /// every entry must carry an identity, a plugin, and a measured size, and QAIRT
    /// bundles must report their compiled context from the bundle itself.
    #[test]
    fn manifest_scan_reports_identity_size_and_qairt_context() {
        let manifest = scan_model_manifest();
        // No cache at all → empty manifest is correct, and the test has nothing to pin.
        let Some(qwen3_4b) = manifest.iter().find(|e| e.r#ref == "qualcomm/Qwen3-4B") else {
            if !get_geniex_models_dirs().iter().any(|d| d.exists()) {
                return;
            }
            panic!("cache exists but qualcomm/Qwen3-4B was not found by the scan");
        };
        assert_eq!(qwen3_4b.plugin, "qairt");
        assert!(qwen3_4b.total_bytes > 1_000_000_000, "4B W4A16 bundle is ~3 GB, got {}", qwen3_4b.total_bytes);
        assert!(qwen3_4b.precisions.iter().any(|p| p.eq_ignore_ascii_case("W4A16")));
        assert_eq!(qwen3_4b.compiled_context, Some(4096));
        assert!(qwen3_4b.context_lengths.contains(&4096));
        // The bundle declares its chipset; the field is present (value pinned loosely:
        // it must name a Snapdragon family, whatever the exact bundle revision).
        let chipset = qwen3_4b.chipset.clone().expect("QAIRT metadata.json declares chipset_attributes");
        let chipset_str = chipset.to_string().to_lowercase();
        assert!(chipset_str.contains("snapdragon"), "chipset attributes should name the chipset family: {chipset_str}");
        assert_eq!(qwen3_4b.use_case.as_deref(), Some("Text Generation"));
        // Vision bundles declare their projector; text bundles must not grow one.
        assert!(qwen3_4b.mmproj_file.is_none(), "a text bundle has no vision projector");
        if let Some(vlm) = manifest.iter().find(|e| e.model_type.as_deref() == Some("vlm")) {
            assert!(vlm.mmproj_file.is_some(), "a vlm artifact carries its projector: {}", vlm.r#ref);
        }
    }

    #[test]
    fn evidence_upsert_is_idempotent_and_rejects_unknown_kinds() {
        let tmp = std::env::temp_dir().join(format!("mkmn-evidence-test-{}", std::process::id()));
        let path = tmp.join("model-evidence.json");
        let record = EvidenceRecord {
            id: "made-up-kind:org/name".to_string(),
            kind: "made-up-kind".to_string(),
            r#ref: "org/name".to_string(),
            as_of: "2026-11-06T00:00:00Z".to_string(),
            machine: "test".to_string(),
            runtime_version: "test".to_string(),
            config: None,
            result: None,
        };
        assert!(upsert_evidence_into(&path, std::slice::from_ref(&record)).is_err(), "unknown kinds are rejected");
        assert!(!path.exists(), "a rejected record writes nothing");

        let mut valid = record;
        valid.id = "download-verified:test:org/name".to_string();
        valid.kind = "download-verified".to_string();
        valid.r#ref = "test:org/name".to_string();
        let all = upsert_evidence_into(&path, &[valid.clone()]).expect("valid record is accepted");
        assert_eq!(all.len(), 1);
        // Upserting the same id replaces, never duplicates (no contradictory records).
        let mut updated = valid.clone();
        updated.as_of = "2026-11-06T12:00:00Z".to_string();
        let all = upsert_evidence_into(&path, &[updated]).expect("upsert works");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].as_of, "2026-11-06T12:00:00Z");
        assert_eq!(load_evidence_from(&path).len(), 1);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn evidence_store_tolerates_a_missing_or_broken_file() {
        let tmp = std::env::temp_dir().join(format!("mkmn-evidence-empty-{}", std::process::id()));
        assert!(load_evidence_from(&tmp.join("does-not-exist.json")).is_empty());
        let broken = tmp.join("broken.json");
        fs::create_dir_all(&tmp).unwrap();
        fs::write(&broken, "{not json").unwrap();
        assert!(load_evidence_from(&broken).is_empty(), "a broken store reads as empty, never as an error");
        let _ = fs::remove_dir_all(&tmp);
    }
}
