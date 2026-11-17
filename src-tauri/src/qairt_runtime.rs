//! The QAIRT runtime a native (QAIRT) GenieX model runs against.
//!
//! Measured on this PC (Snapdragon X2 Elite, HTP v81, GenieX 0.11.0): a Windows
//! driver package (the Microsoft Effect Pack extension) puts its own, older
//! `libQnnHtpV81Skel.so` in the DriverStore. When GenieX runs with its bundled runtime, the
//! DSP loaded THAT skel, which reads context binaries up to format 3.3, and every bundle
//! compiled with QAIRT 2.50 (format 4.0) failed: "Can't read future blob", then QNN errors
//! 5005 and 1002 and `SDKError(Model loading failed)`. The same GenieX files, copied into a
//! folder and passed with `--qairt-lib`, loaded and answered: the override makes GenieX point
//! the DSP loader at that folder. Before this module that folder had to be made by hand and
//! named in the `qairtLib` setting; now, when the setting is empty, MKMN copies the matching
//! files of the INSTALLED GenieX (never a download, never another version) into
//! `%LOCALAPPDATA%\MKMN\QAIRT\geniex-<identity>` and passes that folder. A GenieX update
//! changes the identity, so the copy always matches the runtime GenieX itself bundles.

use std::path::{Path, PathBuf};

/// Where the installed GenieX CLI keeps its bundled QAIRT runtime (`<install>\qairt\htp-files`).
pub fn bundled_dir(geniex_exe: &Path) -> Option<PathBuf> {
    Some(geniex_exe.parent()?.join("qairt").join("htp-files"))
}

fn find_ci(names: &[String], wanted: &str) -> Option<String> {
    names.iter().find(|n| n.eq_ignore_ascii_case(wanted)).cloned()
}

/// The files of a flat QAIRT runtime folder that make one runtime: the two host libraries,
/// then, for every Hexagon architecture the folder carries, its stub, its DSP skel and the
/// signed catalog of that skel (exactly the set the override held). Empty when
/// the folder does not hold a complete runtime for at least one architecture.
pub fn runtime_set(names: &[String]) -> Vec<String> {
    let (Some(htp), Some(system)) = (find_ci(names, "QnnHtp.dll"), find_ci(names, "QnnSystem.dll")) else {
        return Vec::new();
    };
    let mut archs: Vec<String> = names
        .iter()
        .filter_map(|n| {
            let lower = n.to_ascii_lowercase();
            let arch = lower.strip_prefix("qnnhtpv")?.strip_suffix("stub.dll")?;
            (!arch.is_empty() && arch.chars().all(|c| c.is_ascii_digit())).then(|| arch.to_string())
        })
        .collect();
    archs.sort();
    archs.dedup();
    let mut set = vec![htp, system];
    for arch in archs {
        let parts = [
            find_ci(names, &format!("QnnHtpV{arch}Stub.dll")),
            find_ci(names, &format!("libQnnHtpV{arch}Skel.so")),
            find_ci(names, &format!("libqnnhtpv{arch}.cat")),
        ];
        if parts.iter().all(Option::is_some) {
            set.extend(parts.into_iter().flatten());
        }
    }
    if set.len() == 2 { Vec::new() } else { set }
}

fn file_names(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                .filter_map(|e| e.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default()
}

/// A short identity of the source runtime: names, sizes and times of its files, so a GenieX
/// update (new files) gives a new folder and an unchanged install reuses the copy.
fn identity(src: &Path, set: &[String]) -> Option<String> {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    for name in set {
        let meta = std::fs::metadata(src.join(name)).ok()?;
        let modified = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
        digest.update(format!("{}|{}|{};", name.to_ascii_lowercase(), meta.len(), modified).as_bytes());
    }
    Some(digest.finalize().iter().take(6).map(|b| format!("{b:02x}")).collect())
}

fn holds_copy(dir: &Path, src: &Path, set: &[String]) -> bool {
    set.iter().all(|name| match (std::fs::metadata(dir.join(name)), std::fs::metadata(src.join(name))) {
        (Ok(have), Ok(want)) => have.is_file() && have.len() == want.len(),
        _ => false,
    })
}

/// Copies the runtime of `src` into `root\geniex-<identity>` (once: an existing complete
/// copy is reused) and returns that folder. The copy is written to a temporary folder and
/// renamed, so a crash never leaves a half folder that looks complete.
pub fn provision(src: &Path, root: &Path) -> Result<PathBuf, String> {
    let set = runtime_set(&file_names(src));
    if set.is_empty() {
        return Err(format!("{} holds no complete QAIRT runtime (QnnHtp.dll, QnnSystem.dll and a stub, skel and catalog of one architecture)", src.display()));
    }
    let id = identity(src, &set).ok_or_else(|| format!("the files of {} could not be read", src.display()))?;
    let dest = root.join(format!("geniex-{id}"));
    if holds_copy(&dest, src, &set) {
        return Ok(dest);
    }
    let tmp = root.join(format!("geniex-{id}.tmp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("could not create {}: {e}", tmp.display()))?;
    for name in &set {
        if let Err(e) = std::fs::copy(src.join(name), tmp.join(name)) {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(format!("could not copy {name}: {e}"));
        }
    }
    if !holds_copy(&tmp, src, &set) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err("the copied runtime does not match its source".to_string());
    }
    let _ = std::fs::remove_dir_all(&dest); // an incomplete copy of an earlier run
    if let Err(e) = std::fs::rename(&tmp, &dest) {
        let _ = std::fs::remove_dir_all(&tmp);
        // another start may have finished the same copy first
        if holds_copy(&dest, src, &set) {
            return Ok(dest);
        }
        return Err(format!("could not move the runtime into {}: {e}", dest.display()));
    }
    Ok(dest)
}

/// The `--qairt-lib` a start sends. Only a QAIRT model on a GenieX that documents the flag
/// gets one; the person's own folder (the `qairtLib` setting) wins, then an inherited
/// `GENIEX_QAIRT_LIB` (GenieX reads it itself, nothing is sent), then the pinned copy of the
/// installed GenieX's own runtime. A failed copy leaves the bundled runtime, as before.
pub fn effective_qairt_lib(
    configured: Option<&str>,
    env_override: Option<&str>,
    is_qairt: bool,
    flag_supported: bool,
    provisioned: impl FnOnce() -> Option<PathBuf>,
) -> Option<String> {
    let configured = configured.map(str::trim).filter(|s| !s.is_empty());
    if !is_qairt || !flag_supported {
        return configured.map(str::to_string);
    }
    if let Some(path) = configured {
        return Some(path.to_string());
    }
    if env_override.map(str::trim).is_some_and(|s| !s.is_empty()) {
        return None;
    }
    provisioned().map(|p| p.to_string_lossy().into_owned())
}

/// The pinned runtime folder for `geniex_exe`, made when missing; `None` (and a log line) when
/// the installed GenieX holds no complete runtime or the copy failed.
pub fn pinned_runtime(geniex_exe: &Path) -> Option<PathBuf> {
    let src = bundled_dir(geniex_exe)?;
    match provision(&src, &crate::paths::get_qairt_dir()) {
        Ok(dir) => Some(dir),
        Err(e) => {
            crate::paths::append_log("mkmn", &format!("[qairt] GenieX's own QAIRT runtime was not pinned, the bundled one is used: {e}"));
            None
        }
    }
}

/// What the installed GenieX lacks to run a model on the NPU, read from its own folders
/// (empty when nothing is missing, or when the model does not use the NPU files).
///
/// Measured on this PC: the real `%LOCALAPPDATA%\GenieX CLI` held 19 of the
/// installer's 61 files (an install whose new files were written elsewhere): no
/// `llama_cpp\libggml-htp-v*.so`, no `libggml-htp.cat`, no `qairt\htp-files` skel or
/// catalog. A GGUF model on the NPU then failed in 0.4 s and a native model loaded the
/// driver's older skel; both reached the person only as `SDKError(Model loading failed)`.
pub fn install_gaps(geniex_exe: &Path, is_qairt: bool, compute: &str, qairt_lib_given: bool) -> Vec<String> {
    let Some(dir) = geniex_exe.parent() else { return Vec::new() };
    let mut gaps = Vec::new();
    if is_qairt {
        if qairt_lib_given {
            return gaps; // the runtime comes from the folder passed with --qairt-lib
        }
        let htp = dir.join("qairt").join("htp-files");
        let names = file_names(&htp);
        if runtime_set(&names).is_empty() {
            let mut missing: Vec<String> = ["QnnHtp.dll", "QnnSystem.dll"]
                .iter()
                .filter(|n| find_ci(&names, n).is_none())
                .map(|n| n.to_string())
                .collect();
            if !names.iter().any(|n| n.to_ascii_lowercase().ends_with("skel.so") && n.to_ascii_lowercase().starts_with("libqnnhtpv")) {
                missing.push("libQnnHtpV<arch>Skel.so".to_string());
            }
            if !names.iter().any(|n| n.to_ascii_lowercase().starts_with("libqnnhtpv") && n.to_ascii_lowercase().ends_with(".cat")) {
                missing.push("libqnnhtpv<arch>.cat".to_string());
            }
            gaps.push(format!("{} has no complete NPU runtime (missing {})", htp.display(), missing.join(", ")));
        }
    } else {
        let c = compute.trim().to_ascii_lowercase();
        let on_npu = c == "npu" || c == "hybrid" || c.starts_with("htp");
        if on_npu {
            let llama = dir.join("llama_cpp");
            let names = file_names(&llama);
            let lower: Vec<String> = names.iter().map(|n| n.to_ascii_lowercase()).collect();
            let mut missing = Vec::new();
            if !lower.iter().any(|n| n.starts_with("libggml-htp-v") && n.ends_with(".so")) {
                missing.push("libggml-htp-v<arch>.so");
            }
            if !lower.iter().any(|n| n == "libggml-htp.cat") {
                missing.push("libggml-htp.cat");
            }
            if !missing.is_empty() {
                gaps.push(format!("{} lacks the NPU kernels of llama.cpp (missing {})", llama.display(), missing.join(", ")));
            }
        }
    }
    gaps
}

/// The sentence a load failure carries when the installed GenieX is incomplete.
pub fn install_gaps_note(gaps: &[String]) -> Option<String> {
    (!gaps.is_empty()).then(|| format!(
        "The installed GenieX is incomplete: {}. Reinstall GenieX (Settings → Developer → Requirements), from this Windows account.",
        gaps.join("; ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real `GenieX CLI` folder found on this PC (19 files).
    const PARTIAL_INSTALL: &[&str] = &[
        "geniex.dll", "geniex.exe", "llama_cpp/geniex_plugin.dll", "llama_cpp/ggml-base.dll", "llama_cpp/ggml-cpu.dll",
        "llama_cpp/ggml-hexagon.dll", "llama_cpp/ggml-opencl.dll", "llama_cpp/ggml.dll", "llama_cpp/llama-common.dll",
        "llama_cpp/llama.dll", "llama_cpp/mtmd.dll", "qairt/geniex-proc-vision.dll", "qairt/geniex-proc.dll",
        "qairt/geniex_core.dll", "qairt/geniex_plugin.dll", "qairt/geniex_vlm.dll", "qairt/htp-files/QnnHtp.dll",
        "qairt/htp-files/QnnHtpV81Stub.dll", "qairt/htp-files/QnnSystem.dll",
    ];

    fn install(root: &Path, files: &[&str]) -> PathBuf {
        for f in files {
            let p = root.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"x").unwrap();
        }
        root.join("geniex.exe")
    }

    #[test]
    fn the_partial_install_found_here_is_named_for_both_engines() {
        let base = std::env::temp_dir().join(format!("mkmn-geniex-partial-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let exe = install(&base, PARTIAL_INSTALL);
        let llama = install_gaps(&exe, false, "npu", false);
        assert_eq!(llama.len(), 1);
        assert!(llama[0].contains("libggml-htp-v<arch>.so") && llama[0].contains("libggml-htp.cat"), "{llama:?}");
        let native = install_gaps(&exe, true, "npu", false);
        assert_eq!(native.len(), 1);
        assert!(native[0].contains("libQnnHtpV<arch>Skel.so") && native[0].contains("libqnnhtpv<arch>.cat"), "{native:?}");
        assert!(install_gaps_note(&native).unwrap().contains("Reinstall GenieX"));
        // a CPU or GPU llama.cpp model needs no NPU kernel; a native model given its own runtime needs no bundled one
        assert!(install_gaps(&exe, false, "cpu", false).is_empty());
        assert!(install_gaps(&exe, false, "gpu", false).is_empty());
        assert!(install_gaps(&exe, true, "npu", true).is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_complete_install_has_no_gaps() {
        let base = std::env::temp_dir().join(format!("mkmn-geniex-full-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let mut files: Vec<&str> = PARTIAL_INSTALL.to_vec();
        files.extend(["llama_cpp/libggml-htp-v81.so", "llama_cpp/libggml-htp.cat", "qairt/htp-files/libQnnHtpV81Skel.so", "qairt/htp-files/libqnnhtpv81.cat"]);
        let exe = install(&base, &files);
        assert!(install_gaps(&exe, false, "npu", false).is_empty());
        assert!(install_gaps(&exe, true, "npu", false).is_empty());
        assert_eq!(install_gaps_note(&[]), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// The real `qairt\htp-files` of GenieX 0.11.0 (names as listed on this PC).
    const GENIEX_0_11: &[&str] = &[
        "calculator_htp.dll", "libCalculator_skel.so", "libqnnhtpv73.cat", "libQnnHtpV73.so", "libQnnHtpV73QemuDriver.so",
        "libQnnHtpV73Skel.so", "libqnnhtpv81.cat", "libQnnHtpV81.so", "libQnnHtpV81Skel.so", "libQnnNetRunDirectV81Skel.so",
        "libQnnSaver.so", "libQnnSystem.so", "libsnpehtpv73.cat", "libSnpeHtpV73Skel.so", "libsnpehtpv81.cat",
        "libSnpeHtpV81Skel.so", "QnnHtp.dll", "QnnHtpPrepare.dll", "QnnHtpV73CalculatorStub.dll", "QnnHtpV73Stub.dll",
        "QnnHtpV81CalculatorStub.dll", "QnnHtpV81Stub.dll", "QnnSystem.dll", "QnnNetRunDirectV81Stub.dll",
    ];

    #[test]
    fn the_runtime_set_of_geniex_0_11_is_the_host_pair_and_each_architecture() {
        let set = runtime_set(&names(GENIEX_0_11));
        assert_eq!(set, names(&[
            "QnnHtp.dll", "QnnSystem.dll",
            "QnnHtpV73Stub.dll", "libQnnHtpV73Skel.so", "libqnnhtpv73.cat",
            "QnnHtpV81Stub.dll", "libQnnHtpV81Skel.so", "libqnnhtpv81.cat",
        ]));
    }

    #[test]
    fn an_incomplete_folder_is_no_runtime() {
        assert!(runtime_set(&names(&["QnnHtp.dll", "QnnSystem.dll"])).is_empty());
        assert!(runtime_set(&names(&["QnnHtpV81Stub.dll", "libQnnHtpV81Skel.so", "libqnnhtpv81.cat", "QnnSystem.dll"])).is_empty());
        // an architecture without its signed catalog is left out (the DSP would refuse an unsigned skel)
        let set = runtime_set(&names(&["QnnHtp.dll", "QnnSystem.dll", "QnnHtpV81Stub.dll", "libQnnHtpV81Skel.so", "QnnHtpV73Stub.dll", "libQnnHtpV73Skel.so", "libqnnhtpv73.cat"]));
        assert_eq!(set, names(&["QnnHtp.dll", "QnnSystem.dll", "QnnHtpV73Stub.dll", "libQnnHtpV73Skel.so", "libqnnhtpv73.cat"]));
    }

    fn fake_runtime(dir: &Path, skel: &[u8]) {
        std::fs::create_dir_all(dir).unwrap();
        for (name, body) in [
            ("QnnHtp.dll", b"htp".as_slice()), ("QnnSystem.dll", b"sys"), ("QnnHtpV81Stub.dll", b"stub"),
            ("libQnnHtpV81Skel.so", skel), ("libqnnhtpv81.cat", b"cat"), ("QnnHtpPrepare.dll", b"not needed"),
        ] {
            std::fs::write(dir.join(name), body).unwrap();
        }
    }

    #[test]
    fn provision_copies_exactly_the_runtime_once_and_follows_an_update() {
        let base = std::env::temp_dir().join(format!("mkmn-qairt-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("GenieX CLI").join("qairt").join("htp-files");
        let root = base.join("QAIRT");
        fake_runtime(&src, b"skel-2.50");

        let first = provision(&src, &root).expect("a complete runtime is pinned");
        let mut copied = file_names(&first);
        copied.sort();
        assert_eq!(copied, names(&["QnnHtp.dll", "QnnHtpV81Stub.dll", "QnnSystem.dll", "libQnnHtpV81Skel.so", "libqnnhtpv81.cat"]));
        assert_eq!(std::fs::read(first.join("libQnnHtpV81Skel.so")).unwrap(), b"skel-2.50");
        assert!(!first.to_string_lossy().contains(' '), "the pinned folder has no space in its own name");
        assert_eq!(provision(&src, &root).unwrap(), first, "an unchanged install reuses its copy");

        // a GenieX update brings another skel: another folder, holding the new files
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(src.join("libQnnHtpV81Skel.so"), b"skel-2.51-longer").unwrap();
        let second = provision(&src, &root).unwrap();
        assert_ne!(second, first);
        assert_eq!(std::fs::read(second.join("libQnnHtpV81Skel.so")).unwrap(), b"skel-2.51-longer");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn provision_refuses_a_folder_without_a_runtime() {
        let base = std::env::temp_dir().join(format!("mkmn-qairt-empty-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        assert!(provision(&base, &base.join("QAIRT")).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_person_s_folder_wins_then_the_environment_then_the_pinned_copy() {
        let pinned = || Some(PathBuf::from(r"C:\MKMN\QAIRT\geniex-abc"));
        // a QAIRT model with nothing set gets the pinned copy (before: no flag, the DriverStore skel)
        assert_eq!(effective_qairt_lib(None, None, true, true, pinned).as_deref(), Some(r"C:\MKMN\QAIRT\geniex-abc"));
        assert_eq!(effective_qairt_lib(Some("  "), None, true, true, pinned).as_deref(), Some(r"C:\MKMN\QAIRT\geniex-abc"));
        assert_eq!(effective_qairt_lib(Some(r"D:\qairt"), None, true, true, pinned).as_deref(), Some(r"D:\qairt"));
        assert_eq!(effective_qairt_lib(None, Some(r"E:\env"), true, true, pinned), None);
        // a llama.cpp model, or a GenieX without the flag, is never given a pinned copy
        assert_eq!(effective_qairt_lib(None, None, false, true, || panic!("not provisioned for llama.cpp")), None);
        assert_eq!(effective_qairt_lib(None, None, true, false, || panic!("not provisioned without the flag")), None);
        // a failed copy leaves the bundled runtime
        assert_eq!(effective_qairt_lib(None, None, true, true, || None), None);
    }
}
