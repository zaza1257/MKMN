use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use serde_json::Value;
use crate::paths::{get_config_dir, get_settings_path};

/// Serializes read-merge-write cycles between Rust threads, and makes each write atomic
/// (write to a temp file, then rename): a reader — the Node sidecar also reads this file —
/// must never observe a truncated or half-written settings.json, and two writers must
/// never overwrite each other's patch.
static SETTINGS_WRITE_LOCK: Mutex<()> = Mutex::new(());

pub fn get_appdata_dir() -> PathBuf {
    get_config_dir()
}

/// The ONE close-behavior setting, shared by the renderer (`closeAction`), the Tauri
/// host: `"quit"` (default — closing the window exits
/// the whole application) or `"tray"` (an EXPLICIT user choice: hide to the
/// notification area and keep running). This replaces the legacy `minimizeToTray`
/// boolean, whose `true` default kept the app running after close — closing MKMN now
/// means quitting unless the user opted into the tray. The legacy key is migrated on
/// load (an explicit tray choice is preserved) and removed from the stored file so
/// every reader (Rust, Node sidecar, renderer) sees exactly one setting.
pub fn migrate_close_settings(v: &mut Value) -> bool {
    // A saved valid choice wins outright; only the superseded legacy key is dropped.
    if matches!(v.get("closeAction").and_then(Value::as_str), Some("tray") | Some("quit")) {
        return match v.as_object_mut() {
            Some(o) => o.remove("minimizeToTray").is_some(),
            None => false,
        };
    }
    // Legacy value maps over: an explicit tray choice is preserved, everything else
    // (absent, invalid, false) becomes the new default — a full exit on close.
    let mapped = match v.get("minimizeToTray") {
        Some(Value::Bool(true)) => "tray",
        _ => "quit",
    };
    if let Some(o) = v.as_object_mut() {
        o.insert("closeAction".into(), Value::String(mapped.into()));
        o.remove("minimizeToTray");
    }
    true
}

/// The ONE context/cache configuration, shared by the renderer, the Tauri host and the
/// llama.cpp path: the top-level `nctxMode`, `kvType` and `kvInRam` keys are
/// authoritative. The legacy `runtime.ctx` / `runtime.kvType` / `runtime.kvInRam`
/// duplicates were consumed only by the old llama argument builder, so two editors
/// could disagree with each other and with what actually ran. This folds them into the
/// top level: kvType/kvInRam copy up when absent and are dropped either way;
/// runtime.ctx copies up as `nctxMode` only when it is one of the window sizes the
/// setting offers, any other number stays a llama.cpp-only override, and a useless 0
/// is dropped. Mirrors reconcileContextSettings in src/shared/settings.ts — keep both
/// in step.
pub fn migrate_context_settings(v: &mut Value) -> bool {
    let before = v.clone();
    if let Some(obj) = v.as_object_mut() {
        let runtime = obj.remove("runtime");
        if let Some(rt) = runtime {
            if let Some(rt_obj) = rt.as_object() {
                let mut next_rt = rt_obj.clone();
                if let Some(kv) = next_rt.remove("kvType")
                    && !obj.contains_key("kvType") {
                        obj.insert("kvType".into(), kv);
                    }
                if let Some(kv) = next_rt.remove("kvInRam")
                    && !obj.contains_key("kvInRam") {
                        obj.insert("kvInRam".into(), kv);
                    }
                if let Some(c) = next_rt.get("ctx").and_then(|x| x.as_i64()) {
                    if matches!(c, 2048 | 4096 | 8192) {
                        if !obj.contains_key("nctxMode") {
                            obj.insert("nctxMode".into(), Value::String(c.to_string()));
                        }
                        next_rt.remove("ctx");
                    } else if c <= 0 {
                        next_rt.remove("ctx");
                    }
                }
                if !next_rt.is_empty() {
                    obj.insert("runtime".into(), Value::Object(next_rt));
                }
                // an emptied runtime object stays removed: one editor per concept
            } else {
                // a non-object runtime key is not ours to fix
                obj.insert("runtime".into(), rt);
            }
        }
    }
    v != &before
}

/// Whether closing the window should hide MKMN to the notification area. Only an
/// explicit user choice ("closeAction": "tray") keeps the app running; the default
/// and every unrecognized value quit the application.
pub fn close_hides_to_tray() -> bool {
    load_settings().get("closeAction").and_then(Value::as_str) == Some("tray")
}

fn read_settings_file_at(path: &std::path::Path) -> Value {
    if path.exists()
        && let Ok(content) = fs::read_to_string(path)
            && let Ok(val) = serde_json::from_str(&content) {
                return val;
            }
    // Defaults when the file doesn't exist. THE one defaults object, generated
    // from src/shared/settingsSchema.ts (was a hand-written json! block that
    // disagreed with the TypeScript fallbacks); see settings_defaults.generated.rs.
    crate::settings_defaults::schema_defaults()
}

// ---------------------------------------------------------------- read-time value checks

/// The generated defaults document, parsed once (the per-read `schema_defaults()`
/// call would re-parse the string on every checked read).
fn defaults_doc() -> &'static Value {
    static D: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    D.get_or_init(crate::settings_defaults::schema_defaults)
}

/// The declaration of a settings key (kind, allowed values, range), from the table
/// generated out of src/shared/settingsSchema.ts. None for a key the schema does
/// not declare — an unknown key is the person's or a future version's, not ours to fix.
pub fn decl_for(key: &str) -> Option<&'static crate::settings_defaults::SchemaDecl> {
    crate::settings_defaults::SCHEMA_DECLS.iter().find(|d| d.key == key)
}

/// The schema's default for a dotted key ("voice.minLevel"); None when undeclared.
pub fn schema_default(key: &str) -> Option<Value> {
    let mut cur = defaults_doc();
    for seg in key.split('.') {
        cur = cur.get(seg)?;
    }
    Some(cur.clone())
}

fn pointer_of(key: &str) -> String {
    String::from("/") + &key.replace('.', "/")
}

fn type_word(v: &Value) -> &'static str {
    match v {
        Value::Null => "empty",
        Value::Bool(_) => "true/false",
        Value::Number(_) => "a number",
        Value::String(_) => "text",
        Value::Array(_) => "a list",
        Value::Object(_) => "an object",
    }
}

/// Why a stored value is not accepted, or None when it is. The Rust twin of
/// `valueProblem` in the schema; both walk the SAME generated declarations.
pub fn value_problem(decl: &crate::settings_defaults::SchemaDecl, v: &Value) -> Option<String> {
    let bad = |what: String| Some(what);
    // null is the stored "not set" of a key whose schema default is null (the Default buttons save it)
    if v.is_null() && crate::settings_defaults::schema_default(decl.key) == Some(Value::Null) {
        return None;
    }
    match decl.kind {
        "boolean" => if v.is_boolean() { None } else { bad(format!("expected true or false, got {}", type_word(v))) },
        "string" => if v.is_string() { None } else { bad(format!("expected text, got {}", type_word(v))) },
        "number" => match v.as_f64() {
            Some(n) if n.is_finite() => {
                if let Some(min) = decl.min && n < min { return bad(format!("below the minimum {}", min)); }
                if let Some(max) = decl.max && n > max { return bad(format!("above the maximum {}", max)); }
                None
            }
            _ => bad(format!("expected a number, got {}", type_word(v))),
        },
        "enum" => if v.is_string() && decl.values.iter().any(|x| v.as_str() == Some(x)) {
            None
        } else {
            bad(format!("not one of: {}", decl.values.join(", ")))
        },
        "model-ref" => if v.is_null() || v.is_string() { None } else { bad(format!("expected a model id or empty, got {}", type_word(v))) },
        "string-list" => match v.as_array() {
            Some(a) if a.iter().all(Value::is_string) => None,
            _ => bad(String::from("expected a list of words")),
        },
        "object" => if v.is_object() { None } else { bad(format!("expected a settings object for \"{}\"", decl.key)) },
        _ => None,
    }
}

/// The value the app acts on for a dotted key: the stored value when it passes the
/// declaration's check, the schema default when the key is absent or invalid, and
/// Null only when the schema does not declare the key. Every engine-facing read of
/// a settings value goes through here, so a bad stored value can never reach the
/// supervisor and a default exists exactly once.
pub fn checked_get(settings: &Value, key: &str) -> Value {
    let stored = settings.pointer(&pointer_of(key));
    match decl_for(key) {
        None => stored.cloned().unwrap_or(Value::Null),
        Some(d) => match stored {
            Some(v) if value_problem(d, v).is_none() => v.clone(),
            _ => schema_default(key).unwrap_or(Value::Null),
        },
    }
}

/// The STORED value only, when it passes the declaration's check: the read for the
/// few places where an absent key must stay absent (the keepalive precedence treats
/// "not saved" differently from "the default"), never falling back to the default.
pub fn checked_stored(settings: &Value, key: &str) -> Option<Value> {
    let stored = settings.pointer(&pointer_of(key))?;
    let d = decl_for(key)?;
    if value_problem(d, stored).is_none() { Some(stored.clone()) } else { None }
}

pub fn checked_str(settings: &Value, key: &str) -> Option<String> {
    checked_get(settings, key).as_str().map(String::from)
}

pub fn checked_bool(settings: &Value, key: &str) -> Option<bool> {
    checked_get(settings, key).as_bool()
}

pub fn checked_u64(settings: &Value, key: &str) -> Option<u64> {
    checked_get(settings, key).as_f64().map(|f| f as u64)
}

/// The text the app acts on for a declared text/enum key: the stored value when it
/// passes the check, else the schema default — read from the schema, so no default
/// is restated at the point of use. Total for a declared key.
pub fn checked_string(settings: &Value, key: &str) -> String {
    checked_get(settings, key)
        .as_str()
        .map(String::from)
        .unwrap_or_else(|| schema_default(key).and_then(|d| d.as_str().map(String::from)).unwrap_or_default())
}

/// The number the app acts on for a declared number key; see checked_string.
pub fn checked_number(settings: &Value, key: &str) -> f64 {
    checked_get(settings, key)
        .as_f64()
        .unwrap_or_else(|| schema_default(key).and_then(|d| d.as_f64()).unwrap_or(0.0))
}

/// The flag the app acts on for a declared boolean key; see checked_string.
pub fn checked_flag(settings: &Value, key: &str) -> bool {
    checked_get(settings, key)
        .as_bool()
        .unwrap_or_else(|| schema_default(key).and_then(|d| d.as_bool()).unwrap_or(false))
}

// ---------------------------------------------------------------- repair

/// What a load repaired, so the app can tell the person what happened and where
/// the old bytes are. Recorded as a JSON file beside the settings file.
#[derive(serde::Serialize, Clone)]
pub struct RepairNotice {
    /// Unix milliseconds of the repair.
    pub at: u128,
    /// The name the unparseable file was moved to, when it was.
    pub moved_aside: Option<String>,
    /// The name the pre-repair bytes of a parseable file were copied to, when a
    /// salvage replaced any value and the file was written back.
    pub backed_up: Option<String>,
    /// The declared keys whose stored value failed its check and was replaced by
    /// the schema default.
    pub salvaged: Vec<String>,
    /// Why the load could not serve the file at all, when it could not.
    pub error: Option<String>,
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// The name a damaged settings file is moved to, beside the original: never deleted.
fn broken_name(path: &std::path::Path) -> PathBuf {
    path.with_file_name(format!(
        "{}.broken-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("settings.json"),
        now_millis()
    ))
}

/// The copy of the pre-repair bytes a salvage keeps, same never-deleted pattern
/// as `broken_name`: a parseable file is repaired IN PLACE, so without this copy
/// the replaced values would be gone for good.
fn before_repair_name(path: &std::path::Path) -> PathBuf {
    path.with_file_name(format!(
        "{}.before-repair-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("settings.json"),
        now_millis()
    ))
}

/// The object a dotted key's leaf sits in, or None when any parent is absent or not
/// an object (an absent parent stores nothing; a non-object parent is either declared
/// itself — its own entry salvages it — or unknown, and not ours to reach through).
fn parent_object_of<'a>(root: &'a mut Value, key: &str) -> Option<&'a mut serde_json::Map<String, Value>> {
    let segs: Vec<&str> = key.split('.').collect();
    let mut cur = root;
    for seg in &segs[..segs.len() - 1] {
        match cur.get_mut(*seg) {
            Some(child) if child.is_object() => cur = &mut *child,
            _ => return None,
        }
    }
    cur.as_object_mut()
}

/// Per-key salvage: every declared key whose stored value fails its check is
/// replaced by the schema default, in place. Unknown keys, absent keys and valid
/// values are kept exactly as they are. Returns the keys it replaced.
fn salvage_invalid_keys(v: &mut Value) -> Vec<String> {
    let mut fixed = Vec::new();
    for d in crate::settings_defaults::SCHEMA_DECLS {
        let last = d.key.rsplit('.').next().unwrap_or(d.key);
        let Some(map) = parent_object_of(v, d.key) else { continue };
        let Some(stored) = map.get(last) else { continue };
        if value_problem(d, stored).is_some()
            && let Some(def) = schema_default(d.key) {
                // Replacing a value with what it already equals (a stored null
                // where the default is null — npuBudgetOverrideGB) is not a
                // repair: it would rewrite the file and record a salvage on
                // EVERY load for no change at all.
                if def != *stored {
                    map.insert(last.to_string(), def);
                    fixed.push(d.key.to_string());
                }
            }
    }
    fixed
}

/// Read the settings file the way the app LOADS it: an unparseable or non-object
/// file is moved aside (`settings.json.broken-<timestamp>`, never deleted) and a
/// fresh file's worth of defaults is served instead; a parseable file keeps every
/// key whose value passes the schema's check and gets the schema default in place
/// of each one that fails. The repair is logged; the notice (if any) is written
/// by the caller while it holds the write lock. The app itself calls
/// `repair_checked_at` (it refuses to write when the original bytes cannot be kept);
/// this shorter form is the tests' reading of the same repair.
#[cfg(test)]
fn repair_settings_at(path: &std::path::Path) -> (Value, Option<RepairNotice>) {
    let r = repair_checked_at(path);
    (r.value, r.notice)
}

// A test-only switch that makes keeping the original bytes fail (the backup copy
// and the move aside), so the paths that must then refuse to write are exercised.
#[cfg(test)]
thread_local! {
    static FAIL_KEEP: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn keep_failure_injected() -> bool {
    #[cfg(test)]
    {
        return FAIL_KEEP.with(|f| f.get());
    }
    #[allow(unreachable_code)]
    false
}

/// Copy the original bytes aside; never touches the original.
fn keep_copy(content: &str, to: &std::path::Path) -> std::io::Result<()> {
    if keep_failure_injected() {
        return Err(std::io::Error::other("injected for a test"));
    }
    fs::write(to, content)
}

/// Move the damaged file aside; never deletes it.
fn move_aside(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    if keep_failure_injected() {
        return Err(std::io::Error::other("injected for a test"));
    }
    fs::rename(from, to)
}

/// What a repair produced: the value to serve, the notice to record, and whether the
/// file on disk may be written. `writable` is false whenever the original bytes are
/// still the only copy and are not a valid settings document we parsed in full (an
/// unreadable file, an unparseable one that could not be moved aside, a salvage whose
/// backup failed): every write path refuses then, so no save can destroy them.
struct Repair {
    value: Value,
    notice: Option<RepairNotice>,
    writable: bool,
}

fn repair_checked_at(path: &std::path::Path) -> Repair {
    if !path.exists() {
        return Repair { value: read_settings_file_at(path), notice: None, writable: true };
    }
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            // Unreadable (permissions, a lock the owner holds): serve defaults,
            // never touch the file we could not read.
            crate::paths::append_log("mkmn", &format!("Settings file {:?} could not be read ({}); serving defaults without touching it", path, e));
            // The bytes could not be read, so no copy of them exists: nothing may
            // write over them.
            return Repair {
                value: read_settings_file_at(path),
                notice: Some(RepairNotice { at: now_millis(), moved_aside: None, backed_up: None, salvaged: Vec::new(), error: Some(format!("the file could not be read: {}; it was left as it was and changes are not saved", e)) }),
                writable: false,
            };
        }
    };
    match serde_json::from_str::<Value>(&content) {
        Ok(mut v) if v.is_object() => {
            let migrated = migrate_humain_mode(&mut v);
            let salvaged = salvage_invalid_keys(&mut v);
            if migrated && salvaged.is_empty() {
                let _ = write_settings_file_at(path, &v);
            }
            if salvaged.is_empty() {
                return Repair { value: v, notice: None, writable: true };
            }
            // The original bytes are kept first — the replaced values are the
            // person's bytes and are never destroyed. Only once a copy exists is the
            // repaired file written back (under the caller's lock).
            let backup = before_repair_name(path);
            if let Err(e) = keep_copy(&content, &backup) {
                crate::paths::append_log("mkmn", &format!("Settings file {:?}: keeping the pre-repair bytes failed ({}); the file is left as it was", path, e));
                return Repair {
                    value: v,
                    notice: Some(RepairNotice {
                        at: now_millis(), moved_aside: None, backed_up: None, salvaged,
                        error: Some(format!("the pre-repair bytes could not be kept ({}); the file was left as it was and changes are not saved until it can be", e)),
                    }),
                    writable: false,
                };
            }
            crate::paths::append_log("mkmn", &format!("Settings file {:?}: the pre-repair bytes were kept at {:?}", path, backup));
            let backed_up = Some(backup.to_string_lossy().into_owned());
            let error = match write_settings_file_at(path, &v) {
                Ok(()) => None,
                Err(e) => {
                    crate::paths::append_log("mkmn", &format!("Settings file {:?}: writing the repaired file failed ({})", path, e));
                    Some(format!("the repaired file could not be written ({}); the values are repaired in memory only", e))
                }
            };
            crate::paths::append_log("mkmn", &format!(
                "Settings file {:?}: {} key(s) failed their check and were replaced by the schema default: {}",
                path,
                salvaged.len(),
                salvaged.join(", ")
            ));
            // A copy of the original exists either way, so later saves may write.
            Repair { value: v, notice: Some(RepairNotice { at: now_millis(), moved_aside: None, backed_up, salvaged, error }), writable: true }
        }
        _ => {
            let target = broken_name(path);
            let moved = match move_aside(path, &target) {
                Ok(()) => true,
                Err(e) => {
                    crate::paths::append_log("mkmn", &format!("Settings file {:?}: moving the damaged file aside failed ({})", path, e));
                    false
                }
            };
            crate::paths::append_log("mkmn", &format!(
                "Settings file {:?} is not a valid settings document; it was {} {:?} and defaults are served instead",
                path,
                if moved { "moved to" } else { "left in place (the move failed); serving defaults beside" },
                target
            ));
            Repair {
                value: read_settings_file_at(path),
                notice: Some(RepairNotice {
                    at: now_millis(),
                    moved_aside: moved.then(|| target.to_string_lossy().into_owned()),
                    backed_up: None,
                    salvaged: Vec::new(),
                    error: Some(if moved {
                        String::from("the file was not a valid settings document")
                    } else {
                        String::from("the file was not a valid settings document and could not be moved aside; it was left as it was and changes are not saved until it can be")
                    }),
                }),
                // Unmoved, the damaged bytes are still the file: never write over them.
                writable: moved,
            }
        }
    }
}

/// The repair notice of this installation, when one was recorded: the file lives
/// beside settings.json and is only ever written by the repair path.
pub fn repair_notice_path() -> PathBuf {
    get_settings_path().with_file_name("settings-repair-notice.json")
}

pub fn read_repair_notice() -> Value {
    fs::read_to_string(repair_notice_path())
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or(Value::Null)
}

fn record_repair_notice(path: &std::path::Path, notice: &RepairNotice) {
    let target = path.with_file_name("settings-repair-notice.json");
    if let Ok(body) = serde_json::to_string_pretty(notice) {
        let _ = fs::write(&target, body);
    }
}


fn migrate_humain_mode(value: &mut Value) -> bool {
    let mode = match value.get("humainMode").and_then(Value::as_str) {
        Some("fuse-node") => "fuse",
        Some("node-fuse") => "node",
        _ => return false,
    };
    value["humainMode"] = Value::String(mode.into());
    true
}

fn remove_retired_web_settings(value: &mut Value) -> bool {
    let mut changed = false;
    if let Some(settings) = value.as_object_mut() {
        for key in ["webSearch", "wikimediaImages", "searchAlways", "searchProvider", "braveKey", "searxngUrl", "searchModelId"] {
            changed |= settings.remove(key).is_some();
        }
    }
    changed
}

pub fn load_settings() -> Value {
    load_settings_at(&get_settings_path())
}

/// The load-and-migrate logic, on an explicit path: the public `load_settings` reads the
/// real one, and the tests exercise the race on their own file.
fn load_settings_at(path: &std::path::Path) -> Value {
    // The migration write takes the SAME lock a patch save takes, and re-reads the file
    // while holding it: a save that lands between this function's first read and the
    // migrated write is never overwritten by an older snapshot (the migrated write goes
    // to the latest state, patch included). The guard is held until the write returns.
    if let Ok(_guard) = SETTINGS_WRITE_LOCK.try_lock() {
        // Repair first (it may move a damaged file aside and write a fresh or
        // salvaged one), then migrate as before.
        let Repair { value: mut current, notice, writable } = repair_checked_at(path);
        if let Some(n) = &notice {
            record_repair_notice(path, n);
        }
        let closed = migrate_close_settings(&mut current);
        let ctx = migrate_context_settings(&mut current);
        // A file whose bytes have no copy is never written, not even by a migration.
        let retired = remove_retired_web_settings(&mut current);
        if (closed || ctx || retired) && writable {
            let _ = write_settings_file_at(path, &current);
        }
        return current;
    }
    // A writer holds the lock: never block readers. Migrate in memory only — the
    // writer's own save runs the migrations too, so the persisted file gains
    // them with its patch either way. The salvage applies in memory as well, but
    // no file is moved aside and no notice is written without the lock.
    let mut val = read_settings_file_at(path);
    if val.is_object() {
        migrate_humain_mode(&mut val);
        salvage_invalid_keys(&mut val);
    }
    migrate_close_settings(&mut val);
    migrate_context_settings(&mut val);
    remove_retired_web_settings(&mut val);
    val
}

fn write_settings_file_at(path: &std::path::Path, current: &Value) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(current)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    // Atomic replacement: the temp file lives in the same directory (same volume), so
    // the final rename is atomic on NTFS. A crash mid-write leaves the old file intact.
    // The temp name carries this process's id: the Node sidecar once used the SAME
    // fixed temp path, so two concurrent writers could rename (or remove) each other's
    // staging file. Unique staging names make that collision impossible; the sidecar
    // additionally routes its writes through this process (one authoritative writer).
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::write(&tmp, &serialized)
        .map_err(|e| format!("Failed to write settings to {:?}: {}", tmp, e))?;
    // A rename over the file fails on Windows mostly while another process holds it
    // open (a reader, a scanner): retry for a short while. Never fall back to writing
    // the file in place, which truncates it first and can leave it empty.
    let mut last = None;
    for attempt in 0..8u64 {
        match fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(25 * (attempt + 1)));
            }
        }
    }
    let _ = fs::remove_file(&tmp);
    Err(format!(
        "Failed to replace settings at {:?}: {}",
        path,
        last.map(|e| e.to_string()).unwrap_or_default()
    ))
}

pub fn save_settings(patch: Value) -> Result<Value, String> {
    let path = get_settings_path();
    let current = save_settings_at(&path, patch)?;
    crate::paths::append_log("mkmn", &format!("Settings saved successfully to {:?}", path));
    Ok(current)
}

/// The read-merge-write cycle, on an explicit path: the public `save_settings` writes the
/// real one, and the tests (here and in the sidecar host's saveSettings path) exercise it
/// on their own file.
pub(crate) fn save_settings_at(path: &std::path::Path, patch: Value) -> Result<Value, String> {
    let _guard = SETTINGS_WRITE_LOCK.lock().map_err(|_| "settings writer poisoned".to_string())?;
    // A save repairs first: an unparseable file is moved aside (its bytes are never
    // overwritten by the patch) and invalid keys are replaced before the patch merges.
    let Repair { value: mut current, notice, writable } = repair_checked_at(path);
    if let Some(n) = &notice {
        record_repair_notice(path, n);
    }
    if !writable {
        // The file's bytes are the only copy and could not be kept aside: a save
        // would destroy them. Refuse, loudly, rather than lose the person's file.
        return Err(format!(
            "The settings file {:?} could not be kept safe before a change, so nothing was saved and the file was left as it was. Free the file (or make its folder writable) and try again.",
            path
        ));
    }
    migrate_close_settings(&mut current);
    migrate_context_settings(&mut current);

    if let (Some(cur_obj), Some(patch_obj)) = (current.as_object_mut(), patch.as_object()) {
        for (k, v) in patch_obj {
            // A value its declaration refuses is never written: before, it reached the disk
            // and the next load salvaged it with a repair notice. Null resets to the default.
            if let Some(d) = decl_for(k)
                && !v.is_null()
                    && let Some(why) = value_problem(d, v) {
                        crate::paths::append_log("mkmn", &format!("[settings] the change to {} was not saved: {}", k, why));
                        continue;
                    }
            cur_obj.insert(k.clone(), v.clone());
        }
    }

    migrate_humain_mode(&mut current);
    remove_retired_web_settings(&mut current);
    write_settings_file_at(path, &current)?;
    Ok(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_null_is_valid_for_a_key_whose_default_is_null() {
        // the installed app logged these two as failed on every read: null IS their stored "not set"
        for key in ["npuBudgetOverrideGB", "geniexPath"] {
            let d = crate::settings_defaults::SCHEMA_DECLS.iter().find(|d| d.key == key).unwrap();
            assert_eq!(value_problem(d, &Value::Null), None, "{key}");
        }
        // a key with a real default still refuses null
        let d = crate::settings_defaults::SCHEMA_DECLS.iter().find(|d| d.key == "closeAction").unwrap();
        assert!(value_problem(d, &Value::Null).is_some());
    }

    #[test]
    fn legacy_humain_modes_keep_the_primary_provider() {
        for (previous, current) in [("fuse-node", "fuse"), ("node-fuse", "node")] {
            let path = test_settings_path(previous);
            fs::write(&path, json!({ "humainMode": previous }).to_string()).unwrap();
            assert_eq!(load_settings_at(&path)["humainMode"], current);
            assert_eq!(save_settings_at(&path, json!({})).unwrap()["humainMode"], current);
            assert_eq!(read_settings_file_at(&path)["humainMode"], current);
            fs::remove_file(&path).unwrap();
        }
    }

    #[test]
    fn legacy_tray_choice_is_preserved() {
        let mut v = json!({ "minimizeToTray": true });
        assert!(migrate_close_settings(&mut v));
        assert_eq!(v["closeAction"], "tray");
        assert!(v.get("minimizeToTray").is_none());
    }

    #[test]
    fn legacy_false_and_absent_map_to_the_new_quit_default() {
        let mut v = json!({ "minimizeToTray": false });
        assert!(migrate_close_settings(&mut v));
        assert_eq!(v["closeAction"], "quit");
        assert!(v.get("minimizeToTray").is_none());

        let mut v = json!({ "appearance": "dark" });
        assert!(migrate_close_settings(&mut v));
        assert_eq!(v["closeAction"], "quit");
        assert_eq!(v["appearance"], "dark"); // untouched
    }

    #[test]
    fn a_saved_close_action_wins_and_the_legacy_key_is_dropped() {
        let mut v = json!({ "closeAction": "quit", "minimizeToTray": true });
        assert!(migrate_close_settings(&mut v)); // changed: legacy key removed
        assert_eq!(v["closeAction"], "quit");
        assert!(v.get("minimizeToTray").is_none());

        let mut v = json!({ "closeAction": "tray", "minimizeToTray": false });
        assert!(migrate_close_settings(&mut v));
        assert_eq!(v["closeAction"], "tray");

        // Already migrated: nothing changes.
        let mut v = json!({ "closeAction": "quit" });
        assert!(!migrate_close_settings(&mut v));
    }

    #[test]
    fn invalid_close_action_values_are_replaced_by_the_default() {
        let mut v = json!({ "closeAction": 42, "minimizeToTray": false });
        assert!(migrate_close_settings(&mut v));
        assert_eq!(v["closeAction"], "quit");

        let mut v = json!({ "closeAction": "minimize" });
        assert!(migrate_close_settings(&mut v));
        assert_eq!(v["closeAction"], "quit");
    }

    /// The context/cache reconciliation: legacy `runtime.*` duplicates fold into the
    /// top-level authoritative keys.
    #[test]
    fn runtime_context_duplicates_fold_into_the_top_level() {
        // kvType and kvInRam copy up when the top level has none, then are dropped.
        let mut v = json!({ "runtime": { "threads": 4, "kvType": "q8_0", "kvInRam": true } });
        assert!(migrate_context_settings(&mut v));
        assert_eq!(v["kvType"], "q8_0");
        assert_eq!(v["kvInRam"], true);
        assert_eq!(v["runtime"]["threads"], 4); // unrelated runtime keys survive
        assert!(v["runtime"].get("kvType").is_none());
        assert!(v["runtime"].get("kvInRam").is_none());

        // A saved top-level choice wins; the duplicate is dropped either way.
        let mut v = json!({ "kvType": "q4_0", "runtime": { "kvType": "q8_0" } });
        assert!(migrate_context_settings(&mut v));
        assert_eq!(v["kvType"], "q4_0");
        assert!(v["runtime"].get("kvType").is_none());
    }

    /// runtime.ctx only becomes nctxMode when it is one of the offered window sizes;
    /// anything else stays a llama.cpp-only override.
    #[test]
    fn runtime_ctx_becomes_nctx_mode_only_for_offered_sizes() {
        let mut v = json!({ "runtime": { "ctx": 4096 } });
        assert!(migrate_context_settings(&mut v));
        assert_eq!(v["nctxMode"], "4096");
        assert!(v["runtime"].is_null()); // emptied runtime is removed entirely

        // A custom window stays a llama.cpp override — the file is already correct,
        // so the migration changes nothing.
        let mut v = json!({ "runtime": { "ctx": 3072 } });
        assert!(!migrate_context_settings(&mut v));
        assert!(v.get("nctxMode").is_none());
        assert_eq!(v["runtime"]["ctx"], 3072);

        // An existing top-level choice wins; the standard ctx is dropped.
        let mut v = json!({ "nctxMode": "2048", "runtime": { "ctx": 8192 } });
        assert!(migrate_context_settings(&mut v));
        assert_eq!(v["nctxMode"], "2048");
        assert!(v["runtime"].get("ctx").is_none());

        // A useless 0 (same as unset) is dropped.
        let mut v = json!({ "runtime": { "ctx": 0 } });
        assert!(migrate_context_settings(&mut v));
        assert!(v.get("nctxMode").is_none());
        assert!(v.get("runtime").is_none());
    }

    /// Nothing changes when there is nothing to migrate.
    #[test]
    fn context_migration_leaves_a_clean_file_untouched() {
        let mut v = json!({ "nctxMode": "4096", "kvType": "f16", "kvInRam": false, "runtime": { "threads": 6, "ctx": 3072 } });
        assert!(!migrate_context_settings(&mut v));
        assert_eq!(v["runtime"]["threads"], 6);
        assert_eq!(v["runtime"]["ctx"], 3072);

        let mut v = json!({ "appearance": "dark" });
        assert!(!migrate_context_settings(&mut v));
    }

    /// A test-private settings file with a unique name per invocation (no `tempfile`
    /// dependency): process id + a nanosecond counter is enough to avoid collisions
    /// between `cargo test` workers.
    fn test_settings_path(tag: &str) -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let unique = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst) as u128;
        let name = format!(
            "mkmn-settings-test-{}-{}-{}.json",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
                + unique
        );
        std::env::temp_dir().join(name)
    }

    /// The sidecar's saveSettings capability sends the patch WRAPPED:
    /// `callHost(..., "saveSettings", [patch])`. The host used to merge the array
    /// itself — `as_object()` on an array is None — so every sidecar-side save (a
    /// saved load profile, a placement badge) was a silent no-op and `placements`
    /// never landed in settings.json at all. The unwrap lives in the sidecar host
    /// (crate::sidecar::settings_patch_of_args); here the full path is pinned: the
    /// array-wrapped patch, unwrapped the way the host now unwraps it, lands its
    /// placements and keeps everything already saved.
    #[test]
    fn the_sidecars_array_wrapped_patch_lands_its_placements() {
        let path = test_settings_path("sidecar-patch");
        write_settings_file_at(&path, &json!({ "selectedModelId": "keep" }))
            .expect("seed settings file");

        let args = json!([{ "placements": { "unsloth/Qwen3-0.6B-GGUF:Q4_0": "npu" } }]);
        let patch = crate::sidecar::settings_patch_of_args(&args)
            .expect("the sidecar's [patch] argument unwraps to the patch object");
        let saved = save_settings_at(&path, patch).expect("save the unwrapped patch");

        assert_eq!(saved["placements"]["unsloth/Qwen3-0.6B-GGUF:Q4_0"], "npu");
        assert_eq!(saved["selectedModelId"], "keep"); // merged, not replaced
        let stored = read_settings_file_at(&path);
        assert_eq!(stored["placements"]["unsloth/Qwen3-0.6B-GGUF:Q4_0"], "npu");
        let _ = fs::remove_file(&path);
    }

    /// Regression for the stale-readout race (review finding #5): a patch save that
    /// lands on a legacy file migrates it and — critically — keeps the patch. The
    /// pre-fix code re-read + migrated under the writer's lock only in the load path,
    /// so a save racing a migrating load could persist an older snapshot and drop the
    /// patch. Here: a legacy file is seeded, then `save_settings_at` is applied; the
    /// result must contain BOTH the migrated `closeAction` and the saved key.
    #[test]
    fn a_patch_value_its_declaration_refuses_is_never_written() {
        let path = test_settings_path("save-refuses-bad");
        write_settings_file_at(&path, &json!({ "subagents": false, "closeAction": "quit" })).expect("seed");
        let saved = save_settings_at(&path, json!({ "subagents": "yes please", "closeAction": "explode", "keepaliveSec": 12 }))
            .expect("save");
        assert_eq!(saved["subagents"], false);
        assert_eq!(saved["closeAction"], "quit");
        assert_eq!(saved["keepaliveSec"], 12);
        let on_disk: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk["subagents"], false);
        assert_eq!(on_disk["closeAction"], "quit");
    }

    #[test]
    fn a_patch_save_landing_on_a_legacy_file_migrates_and_keeps_the_patch() {
        let path = test_settings_path("save-migrates");
        // Seed a legacy file: no closeAction, an explicit tray choice.
        write_settings_file_at(&path, &json!({ "minimizeToTray": true, "keepaliveSec": 12 }))
            .expect("seed legacy settings file");

        let saved = save_settings_at(&path, json!({ "selectedModelId": "model-a" }))
            .expect("save onto a legacy file");

        // The returned snapshot is migrated and carries the patch…
        assert_eq!(saved["closeAction"], "tray");
        assert!(saved.get("minimizeToTray").is_none());
        assert_eq!(saved["selectedModelId"], "model-a");

        // …and so is the persisted file, exactly once, with no legacy residue.
        let stored = read_settings_file_at(&path);
        assert_eq!(stored["closeAction"], "tray");
        assert_eq!(stored["selectedModelId"], "model-a");
        assert_eq!(stored["keepaliveSec"], 12); // pre-existing key preserved
        assert!(stored.get("minimizeToTray").is_none());

        let _ = fs::remove_file(&path);
    }

    /// Regression for the lost-update race (review finding #5): concurrent patches to
    /// DISTINCT keys must all land (read-merge-write serialized by the writer lock),
    /// and concurrent migrating loads must never observe a truncated file or revert a
    /// saved patch. Pre-fix, two writers could each read the same base state and the
    /// last rename would win, silently dropping the other patches.
    #[test]
    fn concurrent_saves_and_migrating_loads_keep_every_patch() {
        let path = test_settings_path("concurrent");
        write_settings_file_at(&path, &json!({ "minimizeToTray": false })).expect("seed file");

        const THREADS: usize = 8;
        let mut handles = Vec::new();
        for i in 0..THREADS {
            let p = path.clone();
            handles.push(std::thread::spawn(move || {
                // Every writer patches its own key; the loaders hammer the migrate
                // path (the file starts legacy, so early loads migrate under lock).
                let save = save_settings_at(&p, json!({ format!("key{i}"): i }))
                    .expect("concurrent save must succeed");
                assert_eq!(save[format!("key{i}")], i);
                let _loaded = load_settings_at(&p);
            }));
        }
        for h in handles {
            h.join().expect("writer thread must not panic");
        }

        let stored = read_settings_file_at(&path);
        assert_eq!(stored["closeAction"], "quit"); // migrated exactly once
        assert!(stored.get("minimizeToTray").is_none());
        for i in 0..THREADS {
            assert_eq!(
                stored[format!("key{i}")],
                i,
                "patch {i} was lost to a concurrent writer"
            );
        }

        let _ = fs::remove_file(&path);
    }

    // ------------------------------------------------------------ repair

    /// Each repair test runs in its own temp folder: the notice file is named for the
    /// settings file's directory, and parallel test workers must not share one.
    fn test_settings_dir(tag: &str) -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let unique = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst) as u128;
        let dir = std::env::temp_dir().join(format!(
            "mkmn-settings-repair-test-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
                + unique
        ));
        fs::create_dir_all(&dir).expect("create the test folder");
        dir
    }

    fn record_repair_notice_of(path: &std::path::Path) -> Option<Value> {
        let notice = path.with_file_name("settings-repair-notice.json");
        let body = fs::read_to_string(notice).ok()?;
        serde_json::from_str(&body).ok()
    }

    /// An unparseable settings file is moved aside (never deleted, never overwritten)
    /// and defaults are served; the notice records where the old bytes are. Called
    /// directly (not through `load_settings_at`, whose fast path skips the repair
    /// side effects when a writer holds the lock — the save-based test below pins
    /// the full path).
    #[test]
    fn an_unparseable_file_is_moved_aside_and_defaults_are_served() {
        let path = test_settings_dir("broken").join("settings.json");
        fs::write(&path, "{ this is not json").expect("seed a broken settings file");

        let (loaded, notice) = repair_settings_at(&path);
        assert_eq!(loaded["closeAction"], "quit"); // a fresh file's worth of defaults
        assert!(loaded.get("appearance").is_some());

        // The old bytes survive under the timestamped name…
        let orig = path.file_name().unwrap().to_string_lossy().into_owned();
        let broken: Vec<_> = fs::read_dir(path.parent().unwrap())
            .expect("list the test folder")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(&orig))
            .filter(|e| e.file_name().to_string_lossy().contains(".broken-"))
            .collect();
        assert_eq!(broken.len(), 1, "exactly the moved-aside copy remains");
        let body = fs::read_to_string(broken[0].path()).expect("read the moved copy");
        assert_eq!(body, "{ this is not json");

        // …the notice says what happened, and the reader command can serve it.
        let n = notice.expect("the repair produced a notice");
        assert!(n.moved_aside.is_some());
        assert!(n.salvaged.is_empty());
        record_repair_notice(&path, &n);
        let served = record_repair_notice_of(&path).expect("the recorded notice reads back");
        assert!(served["moved_aside"].as_str().is_some());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// The full save path onto a damaged file: the move-aside happens under the
    /// writer's lock, the bytes are never overwritten by the patch, and the patch
    /// lands on a fresh defaults file.
    #[test]
    fn a_save_onto_a_damaged_file_moves_it_aside_and_lands_the_patch() {
        let path = test_settings_dir("save-broken").join("settings.json");
        fs::write(&path, "{ this is not json").expect("seed a broken settings file");

        let saved = save_settings_at(&path, json!({ "appearance": "dark" }))
            .expect("save onto a damaged file");
        assert_eq!(saved["appearance"], "dark");
        assert_eq!(saved["closeAction"], "quit"); // the rest is the defaults

        let orig = path.file_name().unwrap().to_string_lossy().into_owned();
        let broken: Vec<_> = fs::read_dir(path.parent().unwrap())
            .expect("list the test folder")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(&orig))
            .filter(|e| e.file_name().to_string_lossy().contains(".broken-"))
            .collect();
        assert_eq!(broken.len(), 1, "the damaged bytes were moved aside");
        assert_eq!(
            fs::read_to_string(broken[0].path()).expect("read the moved copy"),
            "{ this is not json"
        );
        assert!(record_repair_notice_of(&path).is_some(), "the save recorded the notice");

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// A file of the wrong shape (valid JSON, not an object) counts as damaged too.
    #[test]
    fn a_non_object_settings_file_is_damaged_too() {
        let path = test_settings_dir("nonobject").join("settings.json");
        fs::write(&path, "[1, 2, 3]").expect("seed a JSON array");

        let (loaded, notice) = repair_settings_at(&path);
        assert_eq!(loaded["closeAction"], "quit");
        assert!(notice.expect("a notice").moved_aside.is_some());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// Per-key salvage: a file whose parseable object holds invalid values keeps its
    /// good keys byte-for-byte in meaning and gets the schema default in place of
    /// each bad key; unknown keys are kept as they are.
    #[test]
    fn invalid_keys_are_salvaged_one_by_one_and_good_keys_are_kept() {
        let path = test_settings_dir("salvage").join("settings.json");
        write_settings_file_at(
            &path,
            &json!({
                "appearance": "dark",            // valid — kept
                "powerProfile": 7,               // enum given a number — replaced
                "startupTimeoutSec": 30_000,     // above the maximum — replaced
                "voice": { "minLevel": "loud", "ttsSpeed": 1.5 }, // one bad leaf
                "someFutureKey": { "x": 1 }      // undeclared — kept as it is
            }),
        )
        .expect("seed a partially damaged settings file");

        let (loaded, notice) = repair_settings_at(&path);
        assert_eq!(loaded["appearance"], "dark");
        assert_eq!(loaded["powerProfile"], "auto"); // the schema default, not a guessed one
        assert_eq!(loaded["startupTimeoutSec"], 90);
        assert_eq!(loaded["voice"]["minLevel"], 0.015);
        assert_eq!(loaded["voice"]["ttsSpeed"], 1.5); // the good leaf is untouched
        assert_eq!(loaded["someFutureKey"]["x"], 1);

        let salvaged = &notice.expect("a repair notice was recorded").salvaged;
        assert_eq!(salvaged.len(), 3);
        assert!(salvaged.iter().any(|k| k == "powerProfile"));
        assert!(salvaged.iter().any(|k| k == "startupTimeoutSec"));
        assert!(salvaged.iter().any(|k| k == "voice.minLevel"));

        // The repaired file is persisted, so the next load is notice-free.
        let (again, again_notice) = repair_settings_at(&path);
        assert_eq!(again["powerProfile"], "auto");
        assert!(again_notice.is_none(), "a repaired file loads clean");

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// A salvage keeps the pre-repair bytes: the values it replaces are the
    /// person's bytes and are never destroyed. The notice records where the copy
    /// is, the same way a moved-aside file is recorded.
    #[test]
    fn a_salvage_keeps_the_pre_repair_bytes_beside_the_file() {
        let path = test_settings_dir("backup").join("settings.json");
        write_settings_file_at(&path, &json!({ "powerProfile": 7, "appearance": "dark" }))
            .expect("seed a damaged settings file");
        let before = fs::read_to_string(&path).expect("read the seeded file");

        let (loaded, notice) = repair_settings_at(&path);
        assert_eq!(loaded["powerProfile"], "auto");
        let notice = notice.expect("a repair notice was recorded");
        let backup = notice.backed_up.expect("the pre-repair bytes were kept");
        let kept = fs::read_to_string(&backup).expect("read the kept bytes");
        assert_eq!(kept, before, "the kept copy holds the file exactly as it was before the repair");
        let kept_doc: Value = serde_json::from_str(&kept).expect("the kept copy parses");
        assert_eq!(kept_doc["powerProfile"], 7, "the replaced value is recoverable from the copy");
        assert_eq!(kept_doc["appearance"], "dark");

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// When the pre-repair bytes cannot be kept, the salvage must not overwrite the
    /// file: the repaired values serve from memory, the notice says why, and a later
    /// save refuses rather than replacing bytes no copy holds.
    #[test]
    fn a_salvage_whose_backup_fails_leaves_the_file_untouched_and_saves_refuse() {
        let path = test_settings_dir("backup-fails").join("settings.json");
        write_settings_file_at(&path, &json!({ "powerProfile": 7, "appearance": "dark" }))
            .expect("seed a damaged settings file");
        let before = fs::read_to_string(&path).expect("read the seeded file");

        FAIL_KEEP.with(|f| f.set(true));
        let (loaded, notice) = repair_settings_at(&path);
        let saved = save_settings_at(&path, json!({ "appearance": "light" }));
        let _ = load_settings_at(&path);
        FAIL_KEEP.with(|f| f.set(false));

        assert_eq!(loaded["powerProfile"], "auto", "the repaired value still serves from memory");
        let notice = notice.expect("the failed repair is reported");
        assert!(notice.backed_up.is_none());
        assert!(notice.error.is_some(), "the notice says the file was left as it was");
        assert!(saved.is_err(), "a save must refuse while the original bytes have no copy");
        assert_eq!(fs::read_to_string(&path).unwrap(), before, "the file keeps its bytes");

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// An unparseable file that cannot be moved aside is never overwritten: neither a
    /// load's migration write nor a save may replace it with defaults.
    #[test]
    fn an_unparseable_file_that_cannot_be_moved_is_never_overwritten() {
        let path = test_settings_dir("move-fails").join("settings.json");
        fs::write(&path, "{ this is not json").expect("seed an unparseable file");

        FAIL_KEEP.with(|f| f.set(true));
        let loaded = load_settings_at(&path);
        let saved = save_settings_at(&path, json!({ "appearance": "light" }));
        FAIL_KEEP.with(|f| f.set(false));

        assert!(loaded.is_object(), "defaults still serve");
        assert!(saved.is_err(), "a save must refuse while the damaged file could not be kept aside");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ this is not json", "the damaged bytes stay");

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// A clean file is loaded without a notice and without a rewrite: the bytes on
    /// the disk stay the person's own.
    #[test]
    fn a_clean_file_is_loaded_untouched_and_without_a_notice() {
        let path = test_settings_dir("clean").join("settings.json");
        write_settings_file_at(&path, &json!({ "appearance": "dark", "keepaliveSec": 12 }))
            .expect("seed a clean settings file");
        let before = fs::read_to_string(&path).expect("read the seeded file");

        let (loaded, notice) = repair_settings_at(&path);
        assert_eq!(loaded["appearance"], "dark");
        assert_eq!(loaded["keepaliveSec"], 12);
        assert!(notice.is_none(), "no notice for a clean file");

        let after = fs::read_to_string(&path).expect("read the loaded file");
        assert_eq!(before, after, "a clean load must not rewrite the file");

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// The read-time checks: a bad stored value reads as the schema default, a good
    /// one reads as stored, an unknown key reads as stored, and an absent key that
    /// must stay absent stays absent.
    #[test]
    fn checked_reads_fall_back_to_the_schema_default() {
        let bad = json!({
            "powerProfile": "turbo",            // not one of the enum values
            "kvInRam": "yes",                   // boolean given text
            "startupTimeoutSec": 1,             // below the minimum
            "reviewerModelId": 12,              // model-ref given a number
            "voice": { "minLevel": "loud" },    // nested leaf of the wrong type
            "someFutureKey": "kept"             // undeclared
        });
        assert_eq!(checked_get(&bad, "powerProfile"), "auto");
        assert_eq!(checked_bool(&bad, "kvInRam"), Some(false));
        assert_eq!(checked_u64(&bad, "startupTimeoutSec"), Some(90));
        assert_eq!(checked_get(&bad, "reviewerModelId"), Value::Null);
        assert_eq!(checked_get(&bad, "voice.minLevel"), json!(0.015));
        assert_eq!(checked_get(&bad, "someFutureKey"), json!("kept")); // not ours to fix

        let good = json!({ "powerProfile": "power_saver", "voice": { "minLevel": 0.02 } });
        assert_eq!(checked_get(&good, "powerProfile"), "power_saver");
        assert_eq!(checked_get(&good, "voice.minLevel"), json!(0.02));
        assert_eq!(checked_get(&good, "powerProfile.pointer"), Value::Null);

        // "Not saved" must stay "not saved" for the keepalive precedence.
        let absent = json!({});
        assert_eq!(checked_stored(&absent, "keepaliveSec"), None);
        let saved = json!({ "keepaliveSec": 42 });
        assert_eq!(checked_stored(&saved, "keepaliveSec"), Some(json!(42)));
        let invalid = json!({ "keepaliveSec": "soon" });
        assert_eq!(checked_stored(&invalid, "keepaliveSec"), None);
    }

    // ---------------------------------------------- storage guarantees

    /// The FULL public load path on a clean file leaves the bytes untouched.
    /// The seed carries every migrated key already (`closeAction` is
    /// materialized by design when a file lacks it), so the load has nothing
    /// to change: an existing, current file keeps its key set and its bytes.
    #[test]
    fn a_clean_file_survives_the_full_load_path_byte_for_byte() {
        let dir = test_settings_dir("load-byte-identity");
        let path = dir.join("settings.json");
        write_settings_file_at(
            &path,
            &json!({ "appearance": "dark", "closeAction": "quit", "keepaliveSec": 12 }),
        )
        .expect("seed a clean settings file");
        let before = fs::read(&path).expect("read the seeded bytes");

        let loaded = load_settings_at(&path);
        assert_eq!(loaded["appearance"], "dark");
        assert_eq!(loaded["keepaliveSec"], 12);

        let after = fs::read(&path).expect("read the loaded bytes");
        assert_eq!(before, after, "a load must not rewrite a clean file's bytes");

        let _ = fs::remove_dir_all(&dir);
    }

    /// A save onto a clean file repairs nothing: nothing moves aside, no notice
    /// is recorded, and the keys outside the patch keep their stored values.
    #[test]
    fn a_save_onto_a_clean_file_is_repair_less() {
        let dir = test_settings_dir("save-repair-less");
        let path = dir.join("settings.json");
        write_settings_file_at(&path, &json!({ "appearance": "dark", "braveKey": "k" }))
            .expect("seed a clean settings file");

        let saved = save_settings_at(&path, json!({ "keepaliveSec": 42 })).expect("save the patch");
        assert_eq!(saved["keepaliveSec"], 42);
        assert_eq!(saved["appearance"], "dark", "a key outside the patch is kept");
        assert!(saved.get("braveKey").is_none());

        let notice_path = dir.join("settings-repair-notice.json");
        assert!(!notice_path.exists(), "a clean save must not record a repair notice");
        let residue: Vec<String> = fs::read_dir(&dir)
            .expect("list the test folder")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("broken-") || n.contains("before-repair"))
            .collect();
        assert!(residue.is_empty(), "a clean save moves nothing aside: {residue:?}");

        let _ = fs::remove_dir_all(&dir);
    }

    /// Every default the generated document holds reads as itself through the
    /// checked read, the document's nested parents hold the parent-wins form
    /// (the parent's own default object, not a union of leaf defaults), and
    /// the document survives a serialize → parse round-trip unchanged.
    #[test]
    fn the_generated_defaults_read_as_themselves_and_round_trip() {
        let doc = crate::settings_defaults::schema_defaults();
        for d in crate::settings_defaults::SCHEMA_DECLS {
            // A leaf the document deliberately does not materialize inside its
            // stored parent (the parent-wins rule) has no walked default; the
            // checked read then yields Null, which is the honest "not here".
            let def = crate::settings_defaults::schema_default(d.key).unwrap_or(Value::Null);
            assert_eq!(
                checked_get(&doc, d.key),
                def,
                "the generated default of {} does not read back as itself",
                d.key
            );
        }
        // the parent-wins form: a stored parent holds its OWN default object
        assert_eq!(doc["speculativeDecoding"], json!({ "enabled": false }));
        assert_eq!(doc["turnBudget"], Value::Null);
        assert_eq!(doc["runtime"], json!({}));
        let bytes = serde_json::to_string(&doc).expect("serialize the defaults");
        let parsed: Value = serde_json::from_str(&bytes).expect("re-parse the defaults");
        assert_eq!(parsed, doc, "the defaults survive a JSON round-trip unchanged");
    }

    /// A file CREATED by the host (no file existed) holds the defaults: every
    /// declared key READS as the schema default (an empty `runtime` object is
    /// folded away by the context migration by design — "one editor per
    /// concept" — and reads identically to the schema default `{}`), and the
    /// patch lands on top; an EXISTING file keeps its own key set until a
    /// value is written.
    #[test]
    fn a_created_file_holds_every_schema_key_an_existing_file_keeps_its_key_set() {
        // created: no file existed, so the save persists the defaults document
        let dir = test_settings_dir("created-fresh");
        let path = dir.join("settings.json");
        let saved = save_settings_at(&path, json!({ "braveKey": "k" })).expect("create and save");
        for d in crate::settings_defaults::SCHEMA_DECLS {
            // the patch itself lands on top of the defaults, so it reads as patched
            if d.key == "braveKey" { continue; }
            // a leaf whose parent default does not materialize it (the
            // parent-wins rule) reads as Null here — still never invented data
            let def = crate::settings_defaults::schema_default(d.key).unwrap_or(Value::Null);
            assert_eq!(
                checked_get(&saved, d.key),
                def,
                "the created file must read {} as the schema default",
                d.key
            );
        }
        assert!(saved.get("braveKey").is_none());
        assert_eq!(saved["voice"]["autoSend"], json!(true), "nested leaves hold their defaults");
        let reread = read_settings_file_at(&path);
        assert_eq!(reread, saved, "the created file on disk equals the saved snapshot");
        let _ = fs::remove_dir_all(&dir);

        // existing: a seeded subset keeps its key set until a value is written
        let dir = test_settings_dir("existing-subset");
        let path = dir.join("settings.json");
        write_settings_file_at(&path, &json!({ "appearance": "dark" })).expect("seed a subset file");
        let saved = save_settings_at(&path, json!({ "keepaliveSec": 7 })).expect("save the patch");
        assert!(saved.get("voice").is_none(), "no key is materialized into an existing file");
        assert_eq!(saved["appearance"], "dark");
        assert_eq!(saved["keepaliveSec"], 7);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A stored value that already equals the schema default is never
    /// "salvaged" into itself: that would rewrite the file (and keep a backup
    /// copy of it) on every load for no change at all. A value that genuinely
    /// fails its check is still replaced, and still recorded.
    #[test]
    fn a_value_equal_to_its_default_is_not_salvaged() {
        let dir = test_settings_dir("null-default-salvage");
        let path = dir.join("settings.json");
        write_settings_file_at(&path, &json!({ "npuBudgetOverrideGB": null })).expect("seed a default-equal value");
        let before = fs::read(&path).expect("read the seeded bytes");

        let (v, notice) = repair_settings_at(&path);
        assert!(notice.is_none(), "a default-equal value is not a repair");
        assert_eq!(fs::read(&path).expect("read the loaded bytes"), before, "the file is not rewritten");
        assert_eq!(v["npuBudgetOverrideGB"], Value::Null);

        // a genuinely invalid value is still repaired, with its bytes kept
        write_settings_file_at(&path, &json!({ "npuBudgetOverrideGB": 200 })).expect("seed an out-of-range value");
        let (v2, notice2) = repair_settings_at(&path);
        assert!(notice2.is_some(), "an out-of-range value is repaired");
        assert_eq!(v2["npuBudgetOverrideGB"], Value::Null, "the repair lands the schema default");
        assert!(notice2.as_ref().and_then(|n| n.backed_up.as_deref()).map(|p| std::path::Path::new(p).exists()).unwrap_or(false),
            "the pre-repair bytes were kept");

        let _ = fs::remove_dir_all(&dir);
    }
}
