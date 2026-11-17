use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;
use serde::{Deserialize, Serialize};
use windows_sys::Win32::System::Power::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PowerStatusInfo {
    #[serde(rename = "onAcPower")]
    pub on_ac_power: bool,
    #[serde(rename = "batteryPercent")]
    pub battery_percent: Option<u8>,
    #[serde(rename = "powerSaverRecommended")]
    pub power_saver_recommended: bool,
    #[serde(rename = "acLineStatus")]
    pub ac_line_status: u8,
}

/// 0 = system may sleep, 1 = sleep inhibited.
static INHIBIT_REQUESTED: AtomicU8 = AtomicU8::new(0);
static INHIBIT_OWNER: OnceLock<std::thread::Thread> = OnceLock::new();

/// `SetThreadExecutionState` only affects the calling thread, so the request is
/// serviced by ONE dedicated owner thread. Any worker can call set_sleep_inhibit
/// and the state is global, owned, and survives worker-thread turnover; when the
/// flag is cleared the owner releases the inhibition deterministically.
fn ensure_inhibit_owner_thread() {
    let _ = INHIBIT_OWNER.get_or_init(|| {
        std::thread::Builder::new()
            .name("sleep-inhibit-owner".to_string())
            .spawn(|| {
                let mut applied: u8 = 2; // force first application
                loop {
                    let requested = INHIBIT_REQUESTED.load(Ordering::SeqCst);
                    if requested != applied {
                        unsafe {
                            if requested == 1 {
                                // Keep system awake during token generation / benchmark
                                SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
                            } else {
                                // Release: back to normal idle behavior
                                SetThreadExecutionState(ES_CONTINUOUS);
                            }
                        }
                        applied = requested;
                    }
                    std::thread::park_timeout(std::time::Duration::from_millis(500));
                }
            })
            .expect("failed to spawn sleep-inhibit owner thread")
            .thread()
            .clone()
    });
}

pub fn set_sleep_inhibit(prevent_sleep: bool) {
    ensure_inhibit_owner_thread();
    INHIBIT_REQUESTED.store(u8::from(prevent_sleep), Ordering::SeqCst);
    if let Some(owner) = INHIBIT_OWNER.get() {
        owner.unpark();
    }
}

pub fn get_power_status() -> PowerStatusInfo {
    let mut status: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
    let ok = unsafe { GetSystemPowerStatus(&mut status) };
    if ok != 0 {
        let on_ac = status.ACLineStatus == 1;
        let battery = if status.BatteryLifePercent <= 100 {
            Some(status.BatteryLifePercent)
        } else {
            None
        };
        let power_saver = !on_ac && battery.is_some_and(|b| b <= 20);
        PowerStatusInfo {
            on_ac_power: on_ac,
            battery_percent: battery,
            power_saver_recommended: power_saver,
            ac_line_status: status.ACLineStatus,
        }
    } else {
        // Fallback: assume AC power if query fails
        PowerStatusInfo {
            on_ac_power: true,
            battery_percent: None,
            power_saver_recommended: false,
            ac_line_status: 255,
        }
    }
}

pub fn resolve_effective_power_mode(requested: &str) -> &'static str {
    match requested.to_lowercase().as_str() {
        "burst" | "maximum" | "max" => "burst",
        "power_saver" | "battery" | "saver" => "power_saver",
        "sustained_high_performance" | "sustained" => "sustained_high_performance",
        // The other modes GenieX's own --power-mode documents pass through unchanged:
        // they are valid HTP clock modes, not guesses to be coerced.
        "low_power_saver" => "low_power_saver",
        "high_power_saver" => "high_power_saver",
        "low_balanced" => "low_balanced",
        "balanced" => "balanced",
        "high_performance" => "high_performance",
        "auto" | "adaptive" => {
            let p = get_power_status();
            if p.on_ac_power {
                "burst"
            } else if p.battery_percent.is_some_and(|b| b <= 25) {
                "power_saver"
            } else {
                "sustained_high_performance"
            }
        }
        _ => "sustained_high_performance",
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_effective_power_mode;

    #[test]
    fn every_geniex_power_mode_passes_through() {
        // The eight HTP modes GenieX's own --power-mode documents are valid values:
        // none of them may be coerced to a different mode.
        for mode in [
            "burst",
            "high_performance",
            "sustained_high_performance",
            "balanced",
            "low_balanced",
            "power_saver",
            "high_power_saver",
            "low_power_saver",
        ] {
            assert_eq!(resolve_effective_power_mode(mode), mode, "mode {mode} must pass through unchanged");
        }
    }

    #[test]
    fn legacy_synonyms_and_unknowns_still_resolve() {
        assert_eq!(resolve_effective_power_mode("maximum"), "burst");
        assert_eq!(resolve_effective_power_mode("battery"), "power_saver");
        assert_eq!(resolve_effective_power_mode("sustained"), "sustained_high_performance");
        assert_eq!(resolve_effective_power_mode("nonsense"), "sustained_high_performance");
    }
}
