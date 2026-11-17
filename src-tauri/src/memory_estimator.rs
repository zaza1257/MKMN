use std::fs;
use serde::{Deserialize, Serialize};

use crate::paths::get_geniex_models_dirs;

#[repr(C)]
struct MemoryStatusEx {
    dw_length: u32,
    dw_memory_load: u32,
    ull_total_phys: u64,
    ull_avail_phys: u64,
    ull_total_page_file: u64,
    ull_avail_page_file: u64,
    ull_total_virtual: u64,
    ull_avail_virtual: u64,
    ull_avail_extended_virtual: u64,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GlobalMemoryStatusEx(lp_buffer: *mut MemoryStatusEx) -> i32;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEstimate {
    #[serde(rename = "modelRef")]
    pub model_ref: String,
    #[serde(rename = "weightsGB")]
    pub weights_gb: f64,
    #[serde(rename = "kvCacheGB")]
    pub kv_cache_gb: f64,
    #[serde(rename = "scratchpadGB")]
    pub scratchpad_gb: f64,
    #[serde(rename = "totalRequiredGB")]
    pub total_required_gb: f64,
    #[serde(rename = "availableRamGB")]
    pub available_ram_gb: f64,
    #[serde(rename = "totalRamGB")]
    pub total_ram_gb: f64,
    #[serde(rename = "npuBudgetGB")]
    pub npu_budget_gb: f64,
    #[serde(rename = "fits")]
    pub fits: bool,
    #[serde(rename = "recommendedNctx")]
    pub recommended_nctx: u32,
    #[serde(rename = "recommendedKvType")]
    pub recommended_kv_type: String,
    #[serde(rename = "isQairt")]
    pub is_qairt: bool,
    #[serde(rename = "note")]
    pub note: String,
}

pub fn get_available_ram_bytes() -> (u64, u64) {
    let mut mem = MemoryStatusEx {
        dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
        dw_memory_load: 0,
        ull_total_phys: 0,
        ull_avail_phys: 0,
        ull_total_page_file: 0,
        ull_avail_page_file: 0,
        ull_total_virtual: 0,
        ull_avail_virtual: 0,
        ull_avail_extended_virtual: 0,
    };
    let ok = unsafe { GlobalMemoryStatusEx(&mut mem) };
    if ok != 0 {
        (mem.ull_avail_phys, mem.ull_total_phys)
    } else {
        (16 * 1024 * 1024 * 1024, 32 * 1024 * 1024 * 1024)
    }
}

/// The candidate model directories, first match wins: the GenieX CLI's own cache
/// (`~\.cache\geniex\models`, or `%GENIEX_DATADIR%`) and the legacy app-local one.
/// Both the cache's own namespace spelling (`qualcomm/...`) and the catalog's
/// historical one (`ai-hub-models/...`) are tried: the same bundle is stored under
/// one and referenced by the other, and a candidate that only tries the asked-for
/// spelling misses it (which used to misclassify a QAIRT bundle as GGUF).
pub(crate) fn model_candidates(model_ref: &str) -> Vec<std::path::PathBuf> {
    let clean_ref = model_ref.split(':').next().unwrap_or(model_ref);
    let mut refs = vec![clean_ref.to_string()];
    let lowered = clean_ref.to_lowercase();
    if lowered.starts_with("ai-hub-models/") {
        refs.push(format!("qualcomm/{}", &clean_ref["ai-hub-models/".len()..]));
    } else if lowered.starts_with("qualcomm/") {
        refs.push(format!("ai-hub-models/{}", &clean_ref["qualcomm/".len()..]));
    }
    get_geniex_models_dirs()
        .into_iter()
        .flat_map(|dir| refs.iter().map(|r| dir.join(r)).collect::<Vec<_>>())
        .collect()
}

/// A native NPU bundle that is on disk but has no `metadata.json`, which GenieX 0.11.0 reads
/// before loading (seen: such a bundle fails with "Model loading failed", even freshly downloaded).
pub fn qairt_bundle_lacks_metadata(model_ref: &str) -> bool {
    bundle_lacks_metadata_in(&model_candidates(model_ref))
}

fn bundle_lacks_metadata_in(candidates: &[std::path::PathBuf]) -> bool {
    candidates
        .iter()
        .find(|d| d.join("genie_config.json").is_file())
        .is_some_and(|d| !d.join("metadata.json").is_file())
}

pub fn is_qairt_model(model_ref: &str) -> bool {
    is_qairt_in(model_ref, &model_candidates(model_ref))
}

fn is_qairt_in(model_ref: &str, candidates: &[std::path::PathBuf]) -> bool {
    let lower = model_ref.to_ascii_lowercase();
    let (repo, precision) = lower.split_once(':').unwrap_or((&lower, ""));
    for candidate in candidates {
        if let Ok(text) = fs::read_to_string(candidate.join("geniex.json"))
            && let Ok(registry) = serde_json::from_str::<serde_json::Value>(&text) {
            match registry.get("PluginId").and_then(|v| v.as_str()) {
                Some("qairt") => return true,
                Some("llama_cpp") => return false,
                _ => {}
            }
        }
        let Ok(entries) = fs::read_dir(candidate) else { continue };
        let mut gguf = false;
        let mut native = false;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            gguf |= name.ends_with(".gguf");
            native |= matches!(name.as_str(), "genie_config.json" | "text-generator.json")
                || name.ends_with(".serialized") || name.ends_with(".dlc") || name.ends_with(".bin");
        }
        if gguf || native {
            return native && (!gguf || precision.starts_with("w") && precision.contains('a'));
        }
    }
    // Preserve legacy refs before their files are available. An explicit GGUF ref always
    // outweighs publisher naming when there is no artifact evidence.
    !repo.contains("gguf")
        && !precision.starts_with('q')
        && !precision.starts_with("iq")
        && (repo.starts_with("qualcomm/") || repo.starts_with("ai-hub-models/")
            || precision.starts_with('w') && precision.contains('a'))
}

/// The context a QAIRT bundle was COMPILED with, read from the bundle itself. Two
/// manifest shapes exist and both are read:
/// - `genie_config.json` → `dialog.context.size` (what every QAIRT bundle in the
///   cache carries today: the compiled graph's context),
/// - `geniex.json` → `genie.context_lengths` (the largest entry; the shape a bundle
///   with several compiled lengths would use).
///
/// A QAIRT graph answers within its compiled lengths only — a larger requested
/// context is not a configuration, it is a different bundle. None when the bundle is
/// absent or carries no context metadata; the caller then falls back to a
/// conservative default and says so.
pub fn qairt_compiled_context(model_ref: &str) -> Option<u32> {
    for candidate in model_candidates(model_ref) {
        // Primary, real-world shape: the compiled dialog context.
        let genie_config = candidate.join("genie_config.json");
        if genie_config.exists()
            && let Ok(text) = fs::read_to_string(&genie_config)
                && let Ok(v) = serde_json::from_str::<serde_json::Value>(&text)
                    && let Some(size) = v.get("dialog").and_then(|d| d.get("context")).and_then(|c| c.get("size")).and_then(|s| s.as_u64())
                        && size > 0 && size <= u32::MAX as u64 {
                            return Some(size as u32);
                        }
        // Secondary shape: a manifest listing every compiled length.
        let manifest = candidate.join("geniex.json");
        if !manifest.exists() {
            continue;
        }
        let Ok(text) = fs::read_to_string(&manifest) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let Some(lengths) = v.get("genie").and_then(|g| g.get("context_lengths")).and_then(|l| l.as_array()) else { continue };
        if let Some(max) = lengths
            .iter()
            .filter_map(|x| x.as_u64())
            .filter(|n| *n > 0 && *n <= u32::MAX as u64)
            .max()
        {
            return Some(max as u32);
        }
    }
    None
}

pub fn calculate_disk_model_size_bytes(model_ref: &str) -> Option<u64> {
    for candidate in model_candidates(model_ref) {
        if !candidate.exists() {
            continue;
        }
        if candidate.is_file() {
            return candidate.metadata().ok().map(|m| m.len());
        }
        if candidate.is_dir() {
            let mut total: u64 = 0;
            let mut stack = vec![candidate.clone()];
            while let Some(dir) = stack.pop() {
                if let Ok(entries) = fs::read_dir(&dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        let name = entry.file_name().to_string_lossy().to_string();
                        if name.starts_with('.') || name.ends_with(".progress") {
                            continue;
                        }
                        if path.is_dir() {
                            // Nested weight folders (e.g. shard subdirectories) count too.
                            stack.push(path);
                        } else if let Ok(meta) = path.metadata()
                            && meta.is_file() {
                                total += meta.len();
                            }
                    }
                }
            }
            if total > 0 {
                return Some(total);
            }
        }
    }
    None
}

/// Parse a parameter-count token out of a model reference for the fallback weight
/// estimate, e.g. "qwen2.5-7b" -> 7B, "model-14b" -> 14B.
///
/// Tokens are split on word boundaries (alphanumerics and '.' kept together) and must
/// end in a bare "b" suffix, so a 14B or 24B model can never be mistaken for 4B, a 27B
/// model for 7B, or a 1.7B model for 7B — the failure mode of a naive
/// `contains("4b")`-style cascade.
fn estimate_weights_from_name(model_ref: &str, gb: f64) -> u64 {
    let lower = model_ref.to_lowercase();
    for token in lower.split(|c: char| !(c.is_ascii_alphanumeric() || c == '.')) {
        let Some(params_str) = token.strip_suffix('b') else {
            continue;
        };
        let Ok(params) = params_str.parse::<f64>() else {
            continue;
        };
        if !(0.1..=1000.0).contains(&params) {
            continue;
        }
        return params_to_weights_bytes(params, gb);
    }
    // No recognizable size token: stay conservative, not optimistic.
    (4.00 * gb) as u64
}

/// Known parameter counts map to their measured weight footprints; anything else is
/// interpolated linearly (~0.75 GB per billion parameters for 4-8 bit weights).
fn params_to_weights_bytes(params: f64, gb: f64) -> u64 {
    let known = [
        (1.7, 1.76),
        (4.0, 3.20),
        (7.0, 5.50),
        (8.0, 5.50),
        (9.0, 5.40),
        (12.0, 7.40),
        (14.0, 8.40),
        (24.0, 14.60),
        (27.0, 19.50),
    ];
    let est_gb = known
        .iter()
        .find(|(p, _)| (params - p).abs() < 0.05)
        .map(|(_, gb_val)| *gb_val)
        .unwrap_or_else(|| (params * 0.75).max(0.5));
    (est_gb * gb) as u64
}

pub fn estimate_memory(
    model_ref: &str,
    requested_nctx: Option<u32>,
    requested_kv_type: Option<&str>,
) -> MemoryEstimate {
    estimate_memory_credited(model_ref, requested_nctx, requested_kv_type, 0.0)
}

/// The fit gate, as one pure predicate so tests can pin its semantics: the model must
/// fit in the RAM that will be available (already including any credit for memory the
/// runtime WE OWN releases) AND separately inside the NPU budget. The two constraints
/// are kept apart: crediting released RAM must never stretch the NPU budget, which is
/// a property of total RAM, not of what happens to be free right now.
fn fits_in(total_required_gb: f64, available_gb: f64, npu_budget_gb: f64) -> bool {
    total_required_gb <= available_gb && total_required_gb <= npu_budget_gb
}

/// The RAM tier that picks the default window when nothing was asked for, as one pure
/// function so tests can pin it: the ONE fallback decision behind `build_serve_args`'
/// `recommended_nctx.unwrap_or(4096)` (the supervisor logs the window with this reason).
fn context_tier(avail_gb: f64, weights_gb: f64) -> u32 {
    if avail_gb > 12.0 && weights_gb <= 5.5 {
        8192
    } else if avail_gb < 6.0 || weights_gb >= 15.0 {
        2048
    } else {
        4096
    }
}

/// The same estimate, with `extra_available_gb` credited to the free RAM: a model
/// SWITCH stops the resident copy we own before the new one spawns, so its footprint
/// is genuinely available again. Without the credit, a switch is judged as if a second
/// full resident copy had to fit alongside the first — which wrongly refused switches
/// on low-RAM machines.
pub fn estimate_memory_credited(
    model_ref: &str,
    requested_nctx: Option<u32>,
    requested_kv_type: Option<&str>,
    extra_available_gb: f64,
) -> MemoryEstimate {
    let is_qairt = is_qairt_model(model_ref);
    let (avail_bytes, total_bytes) = get_available_ram_bytes();
    let gb = 1024.0 * 1024.0 * 1024.0;
    let avail_gb = (avail_bytes as f64 / gb * 10.0).round() / 10.0;
    let total_gb = (total_bytes as f64 / gb * 10.0).round() / 10.0;
    // POLICY budget, not a measured ceiling: no device allocation limit for the
    // Hexagon was established for this release (the hardware probe's budget in
    // system.rs is the same 75%-of-RAM estimate unless the user sets an exact
    // value). It is a safety margin over total RAM so the shared-memory NPU
    // cannot take everything the OS and the app still need — never quoted to
    // the user as a physical limit, and never the source of a definitive OOM
    // message (the post-load failure, if one comes, says what ACTUALLY happened).
    let npu_budget_gb = (total_gb * 0.75 * 10.0).round() / 10.0;

    // 1. Calculate weights size
    let weights_bytes = calculate_disk_model_size_bytes(model_ref)
        .unwrap_or_else(|| estimate_weights_from_name(model_ref, gb));
    let weights_gb = (weights_bytes as f64 / gb * 100.0).round() / 100.0;

    // 2. Dynamic Context & KV Cache calculation
    let kv_type = requested_kv_type.unwrap_or("f16");
    let kv_bytes_per_elem: f64 = match kv_type.to_lowercase().as_str() {
        "q4_0" => 0.5625,
        "q8_0" => 1.0625,
        _ => 2.0, // f16
    };

    let nctx = if is_qairt {
        // QAIRT has static context compiled into Hexagon NPU graph: the bundle's own
        // compiled lengths decide (fall back to the conservative 4096 when the
        // manifest does not say)
        qairt_compiled_context(model_ref).unwrap_or(4096)
    } else {
        requested_nctx.unwrap_or_else(|| context_tier(avail_gb, weights_gb))
    };

    let (kv_cache_gb, scratchpad_gb) = if is_qairt {
        // QAIRT models compile KV cache and scratchpads into the static QNN graph buffers
        let kv = 0.35;
        let scratch = 0.45;
        (kv, scratch)
    } else {
        // Standard GQA Transformer KV Cache:
        // 32 layers * 8 kv_heads * 128 head_dim * 2 * nctx * bytes_per_elem
        let elem_count = 32.0 * 8.0 * 128.0 * 2.0 * (nctx as f64);
        let kv_raw_bytes = elem_count * kv_bytes_per_elem;
        let kv = ((kv_raw_bytes / gb) * 100.0).round() / 100.0;
        let scratch = if weights_gb > 10.0 { 1.20 } else { 0.60 };
        (kv, scratch)
    };

    let total_required = ((weights_gb + kv_cache_gb + scratchpad_gb) * 100.0).round() / 100.0;
    let credited_avail_gb = avail_gb + extra_available_gb.max(0.0);
    let fits = fits_in(total_required, credited_avail_gb, npu_budget_gb);

    // Recommendation logic under pressure
    let (rec_nctx, rec_kv, note) = if is_qairt {
        let compiled = qairt_compiled_context(model_ref).unwrap_or(4096);
        (
            compiled,
            "W4A16".to_string(),
            format!("Hexagon NPU Native QNN Graph (context & KV cache statically compiled: {} tokens)", compiled),
        )
    } else if fits {
        (
            nctx,
            kv_type.to_string(),
            if extra_available_gb > 0.0 {
                format!(
                    "Fits in unified LPDDR5x RAM with {} tokens context (plus {:.1} GB freed by stopping the resident model)",
                    nctx, extra_available_gb
                )
            } else {
                format!("Fits comfortably in unified LPDDR5x RAM with {} tokens context", nctx)
            },
        )
    } else if weights_gb + 0.3 <= credited_avail_gb {
        (
            2048,
            "q4_0".to_string(),
            "Constrained memory: halved context (2048) and Q4_0 KV-cache recommended".to_string(),
        )
    } else {
        (
            2048,
            "q4_0".to_string(),
            format!("Warning: Model footprint ({:.1} GB) exceeds available RAM ({:.1} GB)", total_required, credited_avail_gb),
        )
    };

    MemoryEstimate {
        model_ref: model_ref.to_string(),
        weights_gb,
        kv_cache_gb,
        scratchpad_gb,
        total_required_gb: total_required,
        available_ram_gb: avail_gb,
        total_ram_gb: total_gb,
        npu_budget_gb,
        fits,
        recommended_nctx: rec_nctx,
        recommended_kv_type: rec_kv,
        is_qairt,
        note,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bundle_without_metadata_is_named_old_and_a_gguf_folder_is_not() {
        let root = std::env::temp_dir().join(format!("mkmn-bundle-{}", std::process::id()));
        let old = root.join("old");
        let new = root.join("new");
        let gguf = root.join("gguf");
        for d in [&old, &new, &gguf] { std::fs::create_dir_all(d).unwrap(); }
        std::fs::write(old.join("genie_config.json"), "{}").unwrap();
        std::fs::write(new.join("genie_config.json"), "{}").unwrap();
        std::fs::write(new.join("metadata.json"), "{}").unwrap();
        std::fs::write(gguf.join("model.gguf"), "x").unwrap();
        assert!(bundle_lacks_metadata_in(std::slice::from_ref(&old)));
        assert!(!bundle_lacks_metadata_in(std::slice::from_ref(&new)));
        assert!(!bundle_lacks_metadata_in(std::slice::from_ref(&gguf)));
        assert!(!is_qairt_in("qualcomm/Qwen3-4B-GGUF:Q4_0", std::slice::from_ref(&gguf)));
        assert!(is_qairt_in("example/native", std::slice::from_ref(&old)));
        std::fs::write(gguf.join("geniex.json"), r#"{"PluginId":"llama_cpp"}"#).unwrap();
        assert!(!is_qairt_in("qualcomm/model", std::slice::from_ref(&gguf)));
        assert!(!bundle_lacks_metadata_in(&[root.join("absent")]));
        let _ = std::fs::remove_dir_all(&root);
    }

    const GB: f64 = 1024.0 * 1024.0 * 1024.0;

    #[test]
    fn size_tokens_are_parsed_on_word_boundaries() {
        let cases: &[(&str, f64)] = &[
            // ("model ref", expected weights GB)
            ("qwen2.5-7b-instruct", 5.50),
            ("llama-3.1-8b", 5.50),
            ("model-14b", 8.40),
            ("model-24b", 14.60),
            ("gemma-2-27b", 19.50),
            ("mixtral-9b", 5.40),
            ("granite-12b", 7.40),
            ("model-1.7b", 1.76),
            ("qwen3-4b", 3.20),
        ];
        for (reference, expected_gb) in cases {
            let bytes = estimate_weights_from_name(reference, GB);
            let got = bytes as f64 / GB;
            assert!(
                (got - expected_gb).abs() < 0.01,
                "{}: expected ~{} GB, got {} GB",
                reference, expected_gb, got
            );
        }
    }

    #[test]
    fn unknown_size_tokens_stay_conservative() {
        // No recognizable token: must use the conservative 4 GB default.
        let bytes = estimate_weights_from_name("some-custom-finetune", GB);
        assert_eq!(bytes, (4.00 * GB) as u64);

        // Unrecognized parameter counts interpolate, never shrink to a smaller class.
        let bytes = estimate_weights_from_name("mystery-3.8b", GB);
        let got = bytes as f64 / GB;
        assert!(got > 2.0 && got < 4.0, "3.8B should interpolate ~2.85 GB, got {}", got);
    }

    #[test]
    fn word_boundaries_reject_non_size_tokens() {
        // "lib" ends in 'b' but is not a size; "8bit" ends in 'bit'.
        let bytes = estimate_weights_from_name("my-lib-model-8bit", GB);
        assert_eq!(bytes, (4.00 * GB) as u64);
    }

    #[test]
    fn fit_gate_respects_credited_ram_without_stretching_the_npu_budget() {
        // The revalidation example: 2 GB free, an 8 GB resident copy we own (released on
        // switch), a 5 GB request. The uncredited gate refused (5 > 2); the credited one
        // must accept, because the resident copy stops before the new model spawns.
        assert!(!fits_in(5.0, 2.0, 24.0), "uncredited: must not fit");
        assert!(fits_in(5.0, 2.0 + 8.0, 24.0), "credited: the released resident copy makes room");

        // The NPU budget stays a separate constraint: released RAM never stretches it.
        assert!(!fits_in(5.0, 2.0 + 8.0, 4.0), "over the NPU budget: refused even with credit");

        // A model bigger than the credited RAM is still refused.
        assert!(!fits_in(11.0, 2.0 + 8.0, 24.0));
    }

    #[test]
    fn ram_tiers_pick_the_window() {
        // The tier logic behind the supervisor's "recommends" log line, pinned so a
        // change to the ONE default-window fallback is a conscious test change.
        let cases: &[(&str, (f64, f64), u32)] = &[
            // (reason, (avail GB, weights GB), expected tier)
            ("roomy RAM, small model: the big window", (13.0, 1.0), 8192),
            ("exactly on the roomy edge still counts as roomy", (12.5, 5.5), 8192),
            ("a heavier model pulls the window down", (12.5, 5.6), 4096),
            ("middle of the road: the standard window", (8.0, 3.0), 4096),
            ("very heavy weights: the small window", (12.5, 15.0), 2048),
            ("tight RAM: the small window", (5.9, 1.0), 2048),
        ];
        for (why, (avail_gb, weights_gb), expected) in cases {
            assert_eq!(
                context_tier(*avail_gb, *weights_gb),
                *expected,
                "{} ({} GB avail, {} GB weights)",
                why, avail_gb, weights_gb
            );
        }
    }

    /// The compiled-context fixture needs the cache-dir override; env mutation is
    /// process-global, so every env-touching test shares this lock (edition 2024
    /// marks set_var unsafe for exactly this reason).
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn qairt_compiled_context_reads_the_largest_compiled_length_from_the_bundle() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("mkmn-est-test-{}", std::process::id()));
        let bundle = tmp.join("models").join("qualcomm").join("Qwen3-1.7B");
        fs::create_dir_all(&bundle).unwrap();
        // The REAL-WORLD shape (verified against the installed cache): the compiled
        // dialog context lives in genie_config.json, dialog.context.size.
        fs::write(
            bundle.join("genie_config.json"),
            r#"{"dialog":{"context":{"version":1,"size":4096,"n-vocab":151936}}}"#,
        )
        .unwrap();

        unsafe { std::env::set_var("GENIEX_DATADIR", &tmp) };
        // The precision suffix is not part of the directory name: the base is read.
        assert_eq!(qairt_compiled_context("qualcomm/Qwen3-1.7B:W4A16"), Some(4096));
        // The old ai-hub-models spelling finds the same bundle (same artifact).
        assert_eq!(qairt_compiled_context("ai-hub-models/Qwen3-1.7B"), Some(4096));

        // The secondary shape on its own: a manifest listing compiled lengths (and no
        // compiled dialog config) is read too.
        let manifest_bundle = tmp.join("models").join("qualcomm").join("Qwen3-1.7B-Manifest");
        fs::create_dir_all(&manifest_bundle).unwrap();
        fs::write(
            manifest_bundle.join("geniex.json"),
            r#"{"genie":{"context_lengths":[512,1024,2048,8192]}}"#,
        )
        .unwrap();
        assert_eq!(qairt_compiled_context("qualcomm/Qwen3-1.7B-Manifest"), Some(8192));

        // No bundle → no compiled context: the caller falls back and says so.
        assert_eq!(qairt_compiled_context("qualcomm/Not-An-Installed-Bundle"), None);

        unsafe { std::env::remove_var("GENIEX_DATADIR") };
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn qairt_compiled_context_reads_the_installed_cache_really() {
        // No fixture: the REAL cache on this machine carries QAIRT bundles whose
        // compiled context is 4096 (Qwen3-1.7B). The estimator must see it — this is
        // the assertion that caught the wrong-file read (geniex.json instead of
        // genie_config.json). Skips silently when the machine has no such cache.
        if let Some(n) = qairt_compiled_context("qualcomm/Qwen3-1.7B:W4A16") {
            assert_eq!(n, 4096, "the installed Qwen3-1.7B graph is compiled with a 4096 context");
        }
    }

    #[test]
    fn qairt_compiled_context_ignores_a_manifest_without_context() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("mkmn-est-empty-{}", std::process::id()));
        let bundle = tmp.join("models").join("qualcomm").join("Empty-Manifest");
        fs::create_dir_all(&bundle).unwrap();
        fs::write(bundle.join("genie_config.json"), r#"{"dialog":{}}"#).unwrap();
        fs::write(bundle.join("geniex.json"), r#"{"genie":{}}"#).unwrap();

        unsafe { std::env::set_var("GENIEX_DATADIR", &tmp) };
        assert_eq!(qairt_compiled_context("qualcomm/Empty-Manifest"), None);

        unsafe { std::env::remove_var("GENIEX_DATADIR") };
        let _ = fs::remove_dir_all(&tmp);
    }
}
