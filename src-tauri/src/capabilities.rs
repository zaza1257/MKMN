//! The versioned GenieX capability contract.
//!
//! MKMN must never assume that the online documentation describes the INSTALLED
//! executable: the installed runtime (v0.10.0, QAIRT 2.50, llama_cpp 19cce69) does
//! not offer the KV-cache flags, and other flags differ between versions. Every
//! flag and request field MKMN uses is therefore probed from the installed
//! executable's own `serve --help` / `--version` output, once per executable
//! identity, and everything that sends a flag consults this manifest first.
//!
//! The cache is keyed by the executable's path, length and modification time: an
//! in-place update (same path, new bytes) invalidates the previous probe result.
//! The probe runs under a deadline — a wedged CLI must not block a model start.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Every `geniex serve` flag MKMN can pass, in the order the command builder uses
/// them. The probe records which of these the installed CLI actually documents;
/// an absent flag is omitted from every command line and reported as not applied.
pub const MKMN_SERVE_FLAGS: &[&str] = &[
    "--model",
    "--nctx",
    "--ngl",
    "--compute",
    "--power-mode",
    "--keepalive",
    "--metrics",
    "--kv-type",
    "--kv-in-ram",
    "--skip-update",
    "--spec-type",
    "--draft-model",
    "--draft-tokens",
    "--draft-min",
    "--draft-p-min",
    "--vit-compute",
    "--origins",
    "--qairt-lib",
    "--log",
];

#[derive(Debug, Clone, Serialize)]
pub struct GeniexCapabilities {
    pub exe_path: String,
    /// The probed executable's identity: length and mtime. An in-place update
    /// (same path, new bytes) changes these and invalidates the cached probe.
    pub exe_len: u64,
    pub exe_mtime_secs: u64,
    pub geniex_version: Option<String>,
    pub qairt_runtime: Option<String>,
    pub llama_cpp_hash: Option<String>,
    /// The subset of `MKMN_SERVE_FLAGS` this executable documents in `serve --help`.
    pub serve_flags: Vec<String>,
    /// The two flags with dedicated handling in MKMN, kept as booleans for the
    /// supervisor's fast path (and for the existing call sites).
    pub kv_type_supported: bool,
    pub kv_in_ram_supported: bool,
    pub probed_at_secs: u64,
    pub probe_ms: u64,
    /// Set when the probe itself failed (the CLI could not be run or timed out):
    /// no flag may then be assumed supported.
    pub probe_error: Option<String>,
}

impl GeniexCapabilities {
    /// True when MKMN may pass this flag to the installed executable.
    pub fn supports(&self, flag: &str) -> bool {
        self.serve_flags.iter().any(|f| f == flag)
    }
}

/// The identity of a probed executable: path, length, mtime.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ExeIdentity {
    path: PathBuf,
    len: u64,
    mtime: u64,
}

fn exe_identity(exe: &Path) -> Option<ExeIdentity> {
    let meta = std::fs::metadata(exe).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some(ExeIdentity { path: exe.to_path_buf(), len: meta.len(), mtime })
}

static CAPABILITIES: RwLock<Option<(ExeIdentity, GeniexCapabilities)>> = RwLock::new(None);

/// The deadline for ONE subcommand probe (`--version` or `serve --help`): a CLI
/// that hangs (update check with no network, a wedged plugin) must not block a
/// model start forever.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Runs one subcommand with a deadline. Returns (combined output, timed_out).
fn run_with_deadline(exe: &Path, args: &[&str]) -> Result<(String, bool), String> {
    let mut cmd = std::process::Command::new(exe);
    cmd.args(args).stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run {} {:?}: {}", exe.display(), args, e))?;
    // Both pipes are drained WHILE the process runs: a help text longer than the pipe buffer would
    // otherwise block the child on a full pipe until the deadline, and every optional flag would be lost.
    let drain = |p: Option<Box<dyn std::io::Read + Send>>| {
        std::thread::spawn(move || {
            let mut out = String::new();
            if let Some(mut p) = p {
                let _ = p.read_to_string(&mut out);
            }
            out
        })
    };
    let out_t = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>));
    let err_t = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>));
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                // the help text is the contract, not the exit code
                let mut out = out_t.join().unwrap_or_default();
                out.push_str(&err_t.join().unwrap_or_default());
                return Ok((out, false));
            }
            Ok(None) => {
                if start.elapsed() >= PROBE_TIMEOUT {
                    let _ = child.kill();
                    return Ok((String::new(), true));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("probe wait failed: {}", e)),
        }
    }
}

/// Parses `--version` output: `Geniex CLI Version: v0.10.0`, `QAIRT Runtime Version: 2.50`,
/// `LlamaCPP Runtime Hash: 19cce69`. Pure, so tests pin the contract's version fields.
fn parse_version(text: &str) -> (Option<String>, Option<String>, Option<String>) {
    let mut geniex = None;
    let mut qairt = None;
    let mut llama = None;
    let text = strip_ansi(text);
    for line in text.lines() {
        let lower = line.to_lowercase();
        let after = |prefix: &str| -> Option<String> {
            let idx = lower.find(prefix)?;
            let rest = line[idx + prefix.len()..].trim();
            Some(rest.to_string()).filter(|s| !s.is_empty())
        };
        if geniex.is_none() {
            geniex = after("geniex cli version:").or_else(|| after("geniex version:"));
        }
        if qairt.is_none() {
            qairt = after("qairt runtime version:");
        }
        if llama.is_none() {
            llama = after("llamacpp runtime hash:").or_else(|| after("llama_cpp runtime hash:"));
        }
    }
    // a line that is only a version ("v0.11.0") is the CLI's, as the sidecar reads it too
    if geniex.is_none() {
        geniex = text.lines().map(str::trim).find(|l| !l.contains(':') && parse_semver(l).is_some()).map(str::to_string);
    }
    (geniex, qairt, llama)
}

/// A serve help that names the flags every GenieX documents; anything less is a partial answer.
fn help_is_complete(flags: &[String]) -> bool {
    ["--model", "--compute"].iter().all(|f| flags.iter().any(|x| x == f))
}

/// The subset of MKMN's serve flags the installed CLI's own help documents.
/// Pure, so tests pin the contract's flag list.
fn parse_serve_flags(help: &str) -> Vec<String> {
    let help = strip_ansi(help);
    let help = help.as_str();
    MKMN_SERVE_FLAGS
        .iter()
        .filter(|f| documents_flag(help, f))
        .map(|f| f.to_string())
        .collect()
}

/// The text without terminal colour codes (ESC '[' ... letter): a coloured help is the same help.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for d in chars.by_ref() {
                if d.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// True when the help names the flag as a whole word: `--model` must not be read inside `--draft-model`.
fn documents_flag(help: &str, flag: &str) -> bool {
    help.match_indices(flag).any(|(i, _)| {
        let before = help[..i].chars().next_back();
        let after = help[i + flag.len()..].chars().next();
        let part = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
        !before.is_some_and(part) && !after.is_some_and(part)
    })
}

/// An incomplete answer is never kept, so the next start asks again instead of losing every
/// option, or the minimum-version check, for the rest of the session.
fn worth_keeping(caps: &GeniexCapabilities) -> bool {
    help_is_complete(&caps.serve_flags) && caps.geniex_version.is_some()
}

/// Probes the installed executable (version + serve flags) under its identity.
/// Results are cached per (path, len, mtime); a second call with the same
/// executable is free, and an in-place update probes again.
pub fn probe(exe: &Path) -> GeniexCapabilities {
    let identity = exe_identity(exe);
    if let Some(ref id) = identity
        && let Ok(guard) = CAPABILITIES.read()
            && let Some((cached_id, caps)) = guard.as_ref()
                && *cached_id == *id {
                    return caps.clone();
                }
    let started = Instant::now();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (mut geniex_version, mut qairt, mut llama, mut serve_flags, mut probe_error) =
        (None, None, None, Vec::new(), None);

    // `--skip-update` keeps the probe from contacting the update server (the update check is off unless the
    // person turns it on); a CLI that does not know the global flag is asked again without it.
    let version = run_with_deadline(exe, &["--skip-update", "--version"])
        .ok()
        .filter(|(t, timed_out)| !timed_out && parse_version(t).0.is_some())
        .map(Ok)
        .unwrap_or_else(|| run_with_deadline(exe, &["--version"]));
    match version {
        Ok((text, timed_out)) => {
            if timed_out {
                probe_error = Some("geniex --version did not answer within the probe deadline".to_string());
            } else {
                let (g, q, l) = parse_version(&text);
                geniex_version = g;
                qairt = q;
                llama = l;
            }
        }
        Err(e) => probe_error = Some(e),
    }
    // `--skip-update` first: a freshly installed GenieX checks for updates before answering and its help came
    // back partial (2 of 19 flags); a help that does not even name --model is asked again without it
    for args in [&["--skip-update", "serve", "--help"][..], &["serve", "--help"][..]] {
        match run_with_deadline(exe, args) {
            Ok((text, timed_out)) => {
                if timed_out {
                    probe_error = Some("geniex serve --help did not answer within the probe deadline".to_string());
                } else {
                    serve_flags = parse_serve_flags(&text);
                    if help_is_complete(&serve_flags) {
                        probe_error = None;
                        break;
                    }
                    probe_error = Some(format!("geniex serve --help answered without its own flags ({} found)", serve_flags.len()));
                }
            }
            Err(e) => probe_error = Some(e),
        }
    }

    let caps = GeniexCapabilities {
        exe_path: exe.display().to_string(),
        exe_len: identity.as_ref().map(|i| i.len).unwrap_or(0),
        exe_mtime_secs: identity.as_ref().map(|i| i.mtime).unwrap_or(0),
        geniex_version,
        qairt_runtime: qairt,
        llama_cpp_hash: llama,
        kv_type_supported: serve_flags.iter().any(|f| f == "--kv-type"),
        kv_in_ram_supported: serve_flags.iter().any(|f| f == "--kv-in-ram"),
        serve_flags,
        probed_at_secs: now,
        probe_ms: started.elapsed().as_millis() as u64,
        probe_error,
    };
    if worth_keeping(&caps)
        && let Some(ref id) = identity
        && let Ok(mut guard) = CAPABILITIES.write() {
            *guard = Some((id.clone(), caps.clone()));
        }
    crate::paths::append_log(
        "geniex",
        &format!(
            "[capabilities] GenieX {} (QAIRT {}, llama_cpp {}) at {}: {} of {} MKMN serve flags supported{}",
            caps.geniex_version.as_deref().unwrap_or("unknown"),
            caps.qairt_runtime.as_deref().unwrap_or("unknown"),
            caps.llama_cpp_hash.as_deref().unwrap_or("unknown"),
            exe.display(),
            caps.serve_flags.len(),
            MKMN_SERVE_FLAGS.len(),
            caps.probe_error.as_deref().map(|e| format!("; probe error: {}", e)).unwrap_or_default()
        ),
    );
    caps
}

/// The minimum GenieX MKMN runs inference with (the sidecar holds the same number in
/// `src/core/geniexGate.ts`; a test reads both). An older CLI, or one whose `--version`
/// cannot be read, is refused before any server is started, adopted or benchmarked.
pub const GENIEX_MIN_VERSION: (u64, u64, u64) = (0, 11, 0);

/// The x.y.z of a reported version ("v0.11.0", "0.12.3-rc1"), or None.
pub fn parse_semver(text: &str) -> Option<(u64, u64, u64)> {
    let t = text.trim().trim_start_matches(['v', 'V']);
    let core = t.split(['-', '+', ' ']).next()?;
    let mut it = core.split('.');
    let a = it.next()?.parse().ok()?;
    let b = it.next()?.parse().ok()?;
    let c = it.next()?.parse().ok()?;
    if it.next().is_some() { return None; }
    Some((a, b, c))
}

fn fmt_ver(v: (u64, u64, u64)) -> String { format!("v{}.{}.{}", v.0, v.1, v.2) }

/// The verdict on what an executable reported: Ok(version) when it may run inference,
/// Err(message for the person) when it is below the minimum or reported nothing valid.
pub fn judge_version(exe: &Path, reported: Option<&str>) -> Result<(u64, u64, u64), String> {
    let min = fmt_ver(GENIEX_MIN_VERSION);
    match reported.and_then(parse_semver) {
        None => Err(format!(
            "The GenieX at {} did not report a valid version. MKMN needs GenieX {} or newer: reinstall it from the setup screen or Settings → Developer → Runtime.",
            exe.display(), min
        )),
        Some(v) if v < GENIEX_MIN_VERSION => Err(format!(
            "GenieX {} is installed, and MKMN needs {} or newer. Update it from the setup screen or Settings → Developer → Runtime.",
            fmt_ver(v), min
        )),
        Some(v) => Ok(v),
    }
}

/// The gate every GenieX start, adoption and benchmark passes: the executable's own
/// `--version` (probed locally, no network) must be at least `GENIEX_MIN_VERSION`.
pub fn require_compatible(exe: &Path) -> Result<(u64, u64, u64), String> {
    #[cfg(test)]
    if let Some(v) = test_versions::reported(exe) {
        return judge_version(exe, Some(&v));
    }
    let caps = probe(exe);
    judge_version(exe, caps.geniex_version.as_deref())
}

/// Tests stand a renamed PowerShell in for geniex.exe (it serves HTTP but prints no GenieX
/// version): each such fake declares the version its `--version` would print.
#[cfg(test)]
pub mod test_versions {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    static VERSIONS: Mutex<Option<HashMap<PathBuf, String>>> = Mutex::new(None);
    pub fn declare(exe: &Path, version: &str) {
        VERSIONS.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(exe.to_path_buf(), version.to_string());
    }
    pub(super) fn reported(exe: &Path) -> Option<String> {
        VERSIONS.lock().unwrap_or_else(|e| e.into_inner()).as_ref()?.get(exe).cloned()
    }
}

/// The geniex.exe the host would run, gated: missing, outdated and unreadable all refuse.
pub fn require_geniex(custom_path: Option<&str>) -> Result<PathBuf, String> {
    let exe = crate::supervisor::GenieXSupervisor::find_geniex(custom_path).ok_or_else(|| {
        format!(
            "GenieX is not installed. MKMN needs GenieX {} or newer to run models on the NPU: install it from the setup screen or Settings → Developer → Runtime.",
            fmt_ver(GENIEX_MIN_VERSION)
        )
    })?;
    require_compatible(&exe)?;
    Ok(exe)
}

/// The banner text for the window when GenieX inference is off (missing, older than the
/// minimum, or no valid version), from what `geniex version` printed; None when it passes.
pub fn version_warning(exe: Option<&Path>, version_output: Option<&str>) -> Option<String> {
    let Some(exe) = exe else {
        return Some(format!(
            "GenieX inference is off: GenieX is not installed. MKMN needs GenieX {} or newer to run models on the NPU (setup screen or Settings → Developer → Runtime).",
            fmt_ver(GENIEX_MIN_VERSION)
        ));
    };
    let reported = version_output.and_then(|t| parse_version(t).0.or_else(|| t.lines().next().map(|l| l.trim().to_string())));
    judge_version(exe, reported.as_deref()).err().map(|e| format!("GenieX inference is off: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_warns_only_when_inference_is_off() {
        let exe = Path::new(r"C:\g\geniex.exe");
        assert!(version_warning(None, None).unwrap().contains("not installed"));
        assert!(version_warning(Some(exe), Some("GenieX CLI Version:     v0.11.0
QAIRT Runtime Version:  2.50")).is_none());
        assert!(version_warning(Some(exe), Some("GenieX CLI Version: v0.12.0")).is_none());
        let old = version_warning(Some(exe), Some("Geniex CLI Version: v0.10.0")).unwrap();
        assert!(old.contains("v0.10.0") && old.contains("v0.11.0 or newer"), "{old}");
        assert!(version_warning(Some(exe), Some("garbage")).unwrap().contains("did not report a valid version"));
        assert!(version_warning(Some(exe), None).is_some());
    }

    #[test]
    fn the_minimum_is_0_11_0_and_older_or_unreadable_versions_are_refused() {
        let exe = Path::new(r"C:\g\geniex.exe");
        assert_eq!(GENIEX_MIN_VERSION, (0, 11, 0));
        assert!(judge_version(exe, Some("v0.11.0")).is_ok());
        assert!(judge_version(exe, Some("v0.11.1")).is_ok());
        assert!(judge_version(exe, Some("v1.0.0")).is_ok());
        assert!(judge_version(exe, Some("0.12.0-rc1")).is_ok());
        let old = judge_version(exe, Some("v0.10.0")).unwrap_err();
        assert!(old.contains("v0.10.0") && old.contains("v0.11.0 or newer"), "{old}");
        assert!(judge_version(exe, Some("v0.9.3")).is_err());
        assert!(judge_version(exe, Some("unknown")).unwrap_err().contains("did not report a valid version"));
        assert!(judge_version(exe, None).is_err());
        assert!(judge_version(exe, Some("v0.11")).is_err());
    }

    #[test]
    fn version_parse_reads_the_installed_contract() {
        let text = "Geniex CLI Version:     v0.10.0\nQAIRT Runtime Version:  2.50\nLlamaCPP Runtime Hash:  19cce69\n";
        let (g, q, l) = parse_version(text);
        assert_eq!(g.as_deref(), Some("v0.10.0"));
        assert_eq!(q.as_deref(), Some("2.50"));
        assert_eq!(l.as_deref(), Some("19cce69"));
    }

    #[test]
    fn version_parse_tolerates_missing_lines() {
        let (g, q, l) = parse_version("Geniex CLI Version: v0.11.0\n");
        assert_eq!(g.as_deref(), Some("v0.11.0"));
        assert_eq!(q, None);
        assert_eq!(l, None);
        assert_eq!(parse_version(""), (None, None, None));
    }

    #[test]
    fn serve_flag_parse_reports_exactly_the_documented_subset() {
        // The installed v0.10.0 help: no KV flags, everything else MKMN uses is there.
        let help = "      --host string        Server listen address\n      --keepalive int      Model idle timeout in seconds\n      --metrics            Expose Prometheus metrics at /metrics\n      --model string          Model to use when request omits model\n      --nctx int32            Context window size, llama_cpp only\n  -n, --ngl int32             Layers to offload to gpu/npu, -1 = all\n  -c, --compute string        Compute unit: cpu, gpu, npu, or hybrid\n      --power-mode string     HTP power/clock-management mode\n      --spec-type string      Speculative decoding type(s), llama_cpp only\n      --draft-model string    Draft/MTP model for draft-* types\n      --draft-tokens int32    Max draft tokens per step\n      --draft-min int32       Min draft tokens per step\n      --draft-p-min float32   Min greedy draft probability\n      --vit-compute string    VLM vision encoder compute unit\n      --qairt-lib string      Run against a different QAIRT runtime\n      --log string        Log level: none, error, warn, info, debug, trace\n";
        let flags = parse_serve_flags(help);
        assert!(flags.contains(&"--model".to_string()));
        assert!(flags.contains(&"--nctx".to_string()));
        assert!(flags.contains(&"--ngl".to_string()));
        assert!(flags.contains(&"--compute".to_string()));
        assert!(flags.contains(&"--power-mode".to_string()));
        assert!(flags.contains(&"--keepalive".to_string()));
        assert!(flags.contains(&"--metrics".to_string()));
        assert!(flags.contains(&"--spec-type".to_string()));
        assert!(flags.contains(&"--draft-model".to_string()));
        assert!(flags.contains(&"--draft-tokens".to_string()));
        assert!(flags.contains(&"--draft-min".to_string()));
        assert!(flags.contains(&"--draft-p-min".to_string()));
        assert!(flags.contains(&"--vit-compute".to_string()));
        assert!(flags.contains(&"--qairt-lib".to_string()));
        assert!(flags.contains(&"--log".to_string()));
        // The two KV flags are NOT in the installed help: the contract must say so.
        assert!(!flags.contains(&"--kv-type".to_string()));
        assert!(!flags.contains(&"--kv-in-ram".to_string()));
    }

    /// After a reinstall GenieX printed in colour, and MKMN read "2 of 19 MKMN serve flags supported":
    /// --qairt-lib, --log and --skip-update were dropped as "not documented". Colour codes are not part of a flag.
    #[test]
    fn a_coloured_help_is_read_like_a_plain_one() {
        let e = '\u{1b}';
        let help = format!(
            "{e}[1mServer Flags:{e}[0m\n      {e}[36m--host{e}[0m string   Server listen address\n      {e}[36m--keepalive{e}[0m int   Model idle timeout\n{e}[1mModel Default Flags:{e}[0m\n      {e}[36m--model{e}[0m string   Model\n  {e}[36m-c{e}[0m, {e}[36m--compute{e}[0m string   Compute unit\n      {e}[36m--qairt-lib{e}[0m string   Run against a different QAIRT runtime\n{e}[1mGlobal Flags:{e}[0m\n      {e}[36m--log{e}[0m string   Log level\n      {e}[36m--skip-update{e}[0m   Skip checking for updates\n"
        );
        let flags = parse_serve_flags(&help);
        for f in ["--model", "--compute", "--qairt-lib", "--log", "--skip-update", "--keepalive"] {
            assert!(flags.contains(&f.to_string()), "{f} missing from {flags:?}");
        }
        assert!(help_is_complete(&flags));
    }

    #[test]
    fn a_partial_help_is_not_complete() {
        // A fresh GenieX answered a partial help and the app kept "2 of 19" for every start
        assert!(!help_is_complete(&["--log".to_string(), "--host".to_string()]));
        assert!(help_is_complete(&["--model".to_string(), "--compute".to_string(), "--nctx".to_string()]));
    }

    #[test]
    fn a_flag_is_read_as_a_whole_word_only() {
        // a help that documents only the draft flags must not report the plain ones
        let help = "  --draft-model string   Draft model\n  --draft-tokens int32\n  --logfile string\n";
        let flags = parse_serve_flags(help);
        assert!(flags.contains(&"--draft-model".to_string()));
        assert!(!flags.contains(&"--model".to_string()));
        assert!(!flags.contains(&"--log".to_string()));
        assert!(documents_flag("-n, --ngl int32", "--ngl"));
        assert!(documents_flag("--log string  Log level", "--log"));
    }

    #[cfg(windows)]
    #[test]
    fn a_long_output_does_not_block_the_probe() {
        // far more than a pipe buffer: the old read-after-exit waited on a full pipe until the deadline
        let cmd = std::path::Path::new(r"C:\Windows\System32\cmd.exe");
        let (out, timed_out) = run_with_deadline(cmd, &["/c", "for /l %i in (1,1,3000) do @echo --metrics-line-%i"]).unwrap();
        assert!(!timed_out);
        assert!(out.contains("--metrics-line-3000"));
    }

    #[test]
    fn supports_is_false_after_a_failed_probe() {
        let caps = GeniexCapabilities {
            exe_path: "x".into(),
            exe_len: 0,
            exe_mtime_secs: 0,
            geniex_version: None,
            qairt_runtime: None,
            llama_cpp_hash: None,
            serve_flags: vec![],
            kv_type_supported: false,
            kv_in_ram_supported: false,
            probed_at_secs: 0,
            probe_ms: 0,
            probe_error: Some("timed out".into()),
        };
        assert!(!caps.supports("--model"));
        assert!(!caps.supports("--kv-type"));
    }

    /// A `--version` that timed out while `serve --help` answered in full must not be kept:
    /// the minimum-version check would refuse every start until the executable changed.
    #[test]
    fn a_probe_without_a_version_is_not_kept() {
        let mut caps = GeniexCapabilities {
            exe_path: "x".into(),
            exe_len: 1,
            exe_mtime_secs: 1,
            geniex_version: None,
            qairt_runtime: None,
            llama_cpp_hash: None,
            serve_flags: vec!["--model".into(), "--compute".into()],
            kv_type_supported: false,
            kv_in_ram_supported: false,
            probed_at_secs: 0,
            probe_ms: 0,
            probe_error: Some("geniex --version did not answer within the probe deadline".into()),
        };
        assert!(!worth_keeping(&caps), "a probe with no version must be asked again");
        caps.geniex_version = Some("v0.11.0".into());
        caps.probe_error = None;
        assert!(worth_keeping(&caps));
        caps.serve_flags = vec!["--model".into()];
        assert!(!worth_keeping(&caps), "a partial help is still not kept");
    }

    /// The version lines both parsers share (src/shared/geniexVersionLines.json): the host's
    /// reading must agree with the sidecar's, or one would allow what the other refuses.
    #[test]
    fn reads_every_shared_version_line_as_the_sidecar_does() {
        let doc: serde_json::Value = serde_json::from_str(include_str!("../../src/shared/geniexVersionLines.json")).expect("valid JSON");
        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() > 8);
        for c in cases {
            let out = c["out"].as_str().unwrap();
            let want = c["version"].as_str().map(str::to_string);
            let got = parse_version(out).0.as_deref().and_then(parse_semver).map(|(a, b, d)| format!("{a}.{b}.{d}"));
            assert_eq!(got, want, "{out:?}");
        }
    }
}
