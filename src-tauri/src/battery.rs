//! The battery read natively, through the battery class driver's IOCTLs (batclass.h):
//! tag, information (full-charged capacity), status (power state, capacity, voltage,
//! rate). The sidecar used to spawn PowerShell (WMI) for every reading — seconds of CPU
//! each, several times a minute on the battery panel and before every auto request.
//! A value Windows marks unknown stays `null`: never a fabricated 0.
//! The conversion from the raw IOCTL results is a pure function, unit-tested.
//!
//! The battery devices are found by enumeration (SetupDi over the battery class
//! interface GUID) and each one is opened by its device path: the fixed name
//! `\\.\Battery0` is not the name Windows gives them, and opening it always failed,
//! which read as "no battery" on PCs that have one. The read FAILED — not "no
//! battery" — when the enumeration finds nothing while the system power status
//! still reports a battery: that answer must not be trusted as present:false.

use serde_json::{json, Value};
use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
    SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInterfaces, SetupDiGetClassDevsW,
    SetupDiGetDeviceInterfaceDetailW, DIGCF_DEVICEINTERFACE, DIGCF_PRESENT, HDEVINFO,
    SP_DEVICE_INTERFACE_DATA, SP_DEVICE_INTERFACE_DETAIL_DATA_W,
};
use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

// CTL_CODE(DeviceType, Function, Method, Access); FILE_DEVICE_BATTERY = 0x29.
const FILE_DEVICE_BATTERY: u32 = 0x0000_0029;
const FILE_READ_ACCESS: u32 = 1;
const METHOD_BUFFERED: u32 = 0;
const fn ctl_code(device_type: u32, function: u32, method: u32, access: u32) -> u32 {
    (device_type << 16) | (access << 14) | (function << 2) | method
}
const IOCTL_BATTERY_QUERY_TAG: u32 = ctl_code(FILE_DEVICE_BATTERY, 0x10, METHOD_BUFFERED, FILE_READ_ACCESS);
const IOCTL_BATTERY_QUERY_INFORMATION: u32 = ctl_code(FILE_DEVICE_BATTERY, 0x11, METHOD_BUFFERED, FILE_READ_ACCESS);
const IOCTL_BATTERY_QUERY_STATUS: u32 = ctl_code(FILE_DEVICE_BATTERY, 0x12, METHOD_BUFFERED, FILE_READ_ACCESS);

// BATTERY_POWER_STATE bits and the "unknown" markers of the battery API.
const BATTERY_POWER_ONLINE: u32 = 0x0000_0001;
const BATTERY_DISCHARGING: u32 = 0x0000_0002;
/// BATTERY_INFORMATION.Capabilities (poclass.h line 129 of the Windows SDK):
/// "capacity is a %, not mWh". The value is the SDK's literal 0x40000000 — bit 0x40
/// is NOT a defined capability flag, and using it silently classified every real
/// pack as absolute-capacity (a percentage read as mWh, a relative rate read as mW).
const BATTERY_CAPACITY_RELATIVE: u32 = 0x4000_0000;
const BATTERY_UNKNOWN_CAPACITY: u32 = u32::MAX;
const BATTERY_UNKNOWN_VOLTAGE: u32 = u32::MAX;
/// BATTERY_UNKNOWN_RATE (0x80000000) read as the i32 the IOCTL returns.
const BATTERY_UNKNOWN_RATE: i32 = i32::MIN;

const BATTERY_INFORMATION_LEVEL: u32 = 0; // BatteryInformation

#[repr(C)]
pub struct BatteryQueryTag {
    waitable: u32,
}

#[repr(C)]
pub struct BatteryQueryInformation {
    battery_tag: u32,
    information_level: u32,
    at_rate: i32,
}

/// BATTERY_INFORMATION: the fields we read keep the layout of batclass.h (32 bytes).
#[repr(C)]
#[derive(Default, Clone, Copy)]
pub struct BatteryInformation {
    capabilities: u32,
    technology: u8,
    reserved: [u8; 3],
    chemistry: [u8; 4],
    designed_capacity: u32,
    full_charged_capacity: u32,
    default_alert1: u32,
    default_alert2: u32,
    critical_bias: i32,
}

#[repr(C)]
pub struct BatteryQueryStatus {
    battery_tag: u32,
    timeout: u32,
}

/// BATTERY_STATUS.
#[repr(C)]
#[derive(Default, Clone, Copy)]
pub struct BatteryStatus {
    power_state: u32,
    capacity: u32,
    voltage: u32,
    rate: i32,
}

/// What the raw IOCTL calls produced (None = the call failed or was not attempted).
pub struct RawBattery {
    /// The battery tag, None or 0 when there is no battery to talk to.
    pub tag: Option<u32>,
    pub information: Option<BatteryInformation>,
    pub status: Option<BatteryStatus>,
}

/// The battery as the app reports it, in the shape of the sidecar's battery reading
/// (`present`, `onMains`, ...). A value Windows marks unknown is `null`, never 0.
#[derive(Debug, Clone, PartialEq)]
pub struct BatterySnapshot {
    pub present: bool,
    pub on_mains: Option<bool>,
    pub discharging: Option<bool>,
    pub remaining_mwh: Option<u32>,
    pub full_mwh: Option<u32>,
    /// Power drawn FROM the battery, in mW (a positive number: the negated class-driver
    /// rate). Null unless the pack really is discharging with a negative rate; on the
    /// mains, an unknown rate, a zero or positive rate on a discharging pack, and a
    /// relative-capacity pack all yield no figure rather than a fabricated 0.
    pub discharge_mw: Option<i32>,
    pub voltage_mv: Option<u32>,
}

/// The pure conversion from the IOCTL results to the snapshot. No hardware needed.
pub fn battery_snapshot(raw: &RawBattery) -> BatterySnapshot {
    let none = BatterySnapshot {
        present: false,
        on_mains: None,
        discharging: None,
        remaining_mwh: None,
        full_mwh: None,
        discharge_mw: None,
        voltage_mv: None,
    };
    match raw.tag {
        Some(t) if t != 0 => {}
        _ => return none, // no battery (tag 0), or the device could not be opened
    };
    let status = match &raw.status {
        Some(s) => *s,
        None => return none, // without a status there is no remaining capacity: like parseBattery, "no battery"
    };
    if status.capacity == BATTERY_UNKNOWN_CAPACITY {
        return none;
    }
    let on_mains = status.power_state & BATTERY_POWER_ONLINE != 0;
    let discharging = !on_mains && status.power_state & BATTERY_DISCHARGING != 0;
    // A pack that reports a relative (percentage) capacity reports no usable milliwatt rate
    // either: no discharge figure is taken from it.
    let relative_capacity = raw
        .information
        .as_ref()
        .is_some_and(|i| i.capabilities & BATTERY_CAPACITY_RELATIVE != 0);
    // Microsoft's convention for the class driver's rate is positive while charging and
    // negative while discharging; the unknown marker (0x80000000) when the driver does not
    // say. A draw is the negation of a really negative rate on a discharging pack. Every
    // other case -- on the mains, a zero or positive rate on a discharging pack (not a
    // draw), an unknown rate, a relative-capacity pack -- has no figure, never a
    // fabricated 0.
    let discharge_mw = if discharging
        && !on_mains
        && status.rate != BATTERY_UNKNOWN_RATE
        && status.rate < 0
        && !relative_capacity
    {
        Some(-status.rate)
    } else {
        None
    };
    let full_mwh = raw
        .information
        .as_ref()
        .filter(|i| i.capabilities & BATTERY_CAPACITY_RELATIVE == 0)
        .map(|i| i.full_charged_capacity)
        .filter(|f| *f > 0 && *f != BATTERY_UNKNOWN_CAPACITY);
    BatterySnapshot {
        present: true,
        on_mains: Some(on_mains),
        discharging: Some(discharging),
        remaining_mwh: Some(status.capacity),
        full_mwh,
        discharge_mw,
        voltage_mv: (status.voltage != BATTERY_UNKNOWN_VOLTAGE).then_some(status.voltage),
    }
}

/// The snapshot as the sidecar's powerReading capability answers it (JSON, nulls kept).
pub fn battery_json(s: &BatterySnapshot, at_ms: u64) -> Value {
    json!({
        "present": s.present,
        "onMains": s.on_mains,
        "discharging": s.discharging,
        "remainingMWh": s.remaining_mwh,
        "fullMWh": s.full_mwh,
        "dischargeMW": s.discharge_mw,
        "voltageMV": s.voltage_mv,
        "at": at_ms,
    })
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateFileW(
        lp_file_name: *const u16,
        dw_desired_access: u32,
        dw_share_mode: u32,
        lp_security_attributes: *mut u8,
        dw_creation_disposition: u32,
        dw_flags_and_attributes: u32,
        h_template_file: *mut u8,
    ) -> *mut core::ffi::c_void;
    fn DeviceIoControl(
        h_device: *mut core::ffi::c_void,
        dw_io_control_code: u32,
        lp_in_buffer: *const u8,
        n_in_buffer_size: u32,
        lp_out_buffer: *mut u8,
        n_out_buffer_size: u32,
        lp_bytes_returned: *mut u32,
        lp_overlapped: *mut u8,
    ) -> i32;
    fn CloseHandle(h_object: *mut core::ffi::c_void) -> i32;
}

const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;
const FILE_SHARE_READ: u32 = 0x1;
const FILE_SHARE_WRITE: u32 = 0x2;
const OPEN_EXISTING: u32 = 3;
const INVALID_HANDLE_VALUE: *mut core::ffi::c_void = -1isize as *mut core::ffi::c_void;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// One IOCTL call with fixed-size in/out buffers. Ok(bytes) = the driver answered, with
/// the number of bytes it actually wrote (some drivers write more, some success-with-0);
/// Err = the driver refused the call.
fn battery_ioctl(h: *mut core::ffi::c_void, code: u32, input: &[u8], output: &mut [u8]) -> Result<u32, String> {
    let mut returned: u32 = 0;
    let ok = unsafe {
        DeviceIoControl(
            h,
            code,
            input.as_ptr(),
            input.len() as u32,
            output.as_mut_ptr(),
            output.len() as u32,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err("the battery IOCTL failed".to_string());
    }
    Ok(returned)
}

/// The JSON the powerReading capability answers with (Err = the native read FAILED;
/// the sidecar then takes its PowerShell fallback instead of trusting a "no battery").
pub fn read_battery_json() -> Result<Value, String> {
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(battery_json(&read_battery_snapshot()?, at))
}

/// The figures of ONE battery, with the unknowns kept (`None`): a battery that answered
/// with a tag IS present even when its status or its capacity could not be read.
#[derive(Debug, Clone, PartialEq)]
struct BatteryFigures {
    on_mains: Option<bool>,
    discharging: Option<bool>,
    remaining_mwh: Option<u32>,
    full_mwh: Option<u32>,
    discharge_mw: Option<i32>,
    voltage_mv: Option<u32>,
}

/// One battery's figures out of its raw IOCTL results. The sign and unknown rules are
/// the single-battery conversion's; only the "cannot be read" collapse differs, because
/// a battery with a tag is there whether or not every figure could be read.
fn one_battery(raw: &RawBattery) -> Option<BatteryFigures> {
    let tagged = matches!(raw.tag, Some(t) if t != 0);
    if !tagged {
        return None;
    }
    let s = battery_snapshot(raw);
    Some(if s.present {
        BatteryFigures {
            on_mains: s.on_mains,
            discharging: s.discharging,
            remaining_mwh: s.remaining_mwh,
            full_mwh: s.full_mwh,
            discharge_mw: s.discharge_mw,
            voltage_mv: s.voltage_mv,
        }
    } else {
        // a tag whose status or capacity could not be read: present, figures unknown
        BatteryFigures {
            on_mains: None,
            discharging: None,
            remaining_mwh: None,
            full_mwh: None,
            discharge_mw: None,
            voltage_mv: None,
        }
    })
}

fn sum_of<T: Copy>(figs: &[BatteryFigures], field: fn(&BatteryFigures) -> Option<T>, add: impl Fn(T, T) -> Option<T>) -> Option<T> {
    let mut total: Option<T> = None;
    for b in figs {
        let v = field(b)?;
        total = match total {
            Some(t) => add(t, v),
            None => Some(v),
        };
    }
    total
}

/// The merged snapshot of every battery found: the remaining and full capacities and
/// the draw are sums, `present` is true when any battery answered with a tag, the
/// mains state is the one all of them share (the first that says), and the voltage the
/// first battery's (packs in parallel share it; a sum would be a lie). One battery's
/// unknown anywhere makes the summed value null — an unknown is never read as 0.
pub fn merged_battery_snapshot(raws: &[RawBattery]) -> BatterySnapshot {
    let figs: Vec<BatteryFigures> = raws.iter().filter_map(one_battery).collect();
    if figs.is_empty() {
        return BatterySnapshot {
            present: false,
            on_mains: None,
            discharging: None,
            remaining_mwh: None,
            full_mwh: None,
            discharge_mw: None,
            voltage_mv: None,
        };
    }
    // onMains is the same for all of them (the first that says); the voltage is the
    // first battery's (packs in parallel share it; a sum would be a lie); the rest are
    // sums. One unknown anywhere makes the summed value null — never a partial number.
    BatterySnapshot {
        present: true,
        on_mains: figs.iter().find_map(|b| b.on_mains),
        discharging: figs.iter().find_map(|b| b.discharging),
        remaining_mwh: sum_of(&figs, |b| b.remaining_mwh, |a, b| a.checked_add(b)),
        full_mwh: sum_of(&figs, |b| b.full_mwh, |a, b| a.checked_add(b)),
        discharge_mw: sum_of(&figs, |b| b.discharge_mw, |a, b| a.checked_add(b)),
        voltage_mv: figs.iter().find_map(|b| b.voltage_mv),
    }
}

/// The system battery state as CallNtPowerInformation answers it (a system-wide read,
/// powrprof): the figures when the per-battery status query is not answered. Some
/// class drivers reply to the status IOCTL with success and no bytes, on every call —
/// on those PCs this read is the only native one, and it is still no PowerShell.
#[derive(Debug, Clone, PartialEq)]
struct SystemBatteryRaw {
    ac_online: bool,
    present: bool,
    discharging: bool,
    max_capacity: u32,
    remaining_capacity: u32,
    rate: u32,
}

/// The thin FFI layer (None = the call failed or the system answered nothing usable).
fn read_system_battery_state() -> Option<SystemBatteryRaw> {
    use windows_sys::Win32::System::Power::{CallNtPowerInformation, SystemBatteryState, SYSTEM_BATTERY_STATE};
    unsafe {
        let mut s: SYSTEM_BATTERY_STATE = std::mem::zeroed();
        let st = CallNtPowerInformation(
            SystemBatteryState,
            std::ptr::null(),
            0,
            &mut s as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<SYSTEM_BATTERY_STATE>() as u32,
        );
        if st != 0 {
            return None;
        }
        Some(SystemBatteryRaw {
            ac_online: s.AcOnLine,
            present: s.BatteryPresent,
            discharging: s.Discharging,
            max_capacity: s.MaxCapacity,
            remaining_capacity: s.RemainingCapacity,
            rate: s.Rate,
        })
    }
}

/// The figures the system battery state yields (None when it reports no battery). The
/// rate follows the same convention as the class driver's: a draw is the negated rate
/// of a discharging pack; unknown, zero or positive rates give no figure. No voltage
/// is carried here, so the voltage stays null rather than a fabricated 0.
fn system_state_figures(sys: &SystemBatteryRaw) -> Option<BatteryFigures> {
    if !sys.present {
        return None;
    }
    let capacity = |v: u32| if v == 0 || v == BATTERY_UNKNOWN_CAPACITY { None } else { Some(v) };
    let rate_i32 = sys.rate as i32;
    Some(BatteryFigures {
        on_mains: Some(sys.ac_online),
        discharging: Some(sys.discharging),
        remaining_mwh: capacity(sys.remaining_capacity),
        full_mwh: capacity(sys.max_capacity),
        discharge_mw: if sys.discharging && !sys.ac_online && rate_i32 != BATTERY_UNKNOWN_RATE && rate_i32 < 0 {
            Some(-rate_i32)
        } else {
            None
        },
        voltage_mv: None,
    })
}

/// True while any of the figures the app shows is still unknown.
fn figures_missing(s: &BatterySnapshot) -> bool {
    s.remaining_mwh.is_none() || s.full_mwh.is_none() || s.discharge_mw.is_none()
}

/// Fills the snapshot's unknown figures with the system battery state's — only the
/// null fields, so a figure read per battery is never replaced by the system-wide one.
fn fill_from_system_state(mut snap: BatterySnapshot, sys: &SystemBatteryRaw) -> BatterySnapshot {
    if let Some(f) = system_state_figures(sys) {
        if snap.on_mains.is_none() {
            snap.on_mains = f.on_mains;
        }
        if snap.discharging.is_none() {
            snap.discharging = f.discharging;
        }
        if snap.remaining_mwh.is_none() {
            snap.remaining_mwh = f.remaining_mwh;
        }
        if snap.full_mwh.is_none() {
            snap.full_mwh = f.full_mwh;
        }
        if snap.discharge_mw.is_none() {
            snap.discharge_mw = f.discharge_mw;
        }
    }
    snap
}

/// The snapshot from the per-battery reads and the system battery state: the merge of
/// the batteries, with the system-wide figures filling in what the per-battery status
/// could not provide.
fn snapshot_from(raws: &[RawBattery], sys: Option<&SystemBatteryRaw>) -> BatterySnapshot {
    let snap = merged_battery_snapshot(raws);
    if snap.present && figures_missing(&snap)
        && let Some(sys) = sys {
            return fill_from_system_state(snap, sys);
        }
    snap
}

/// Reads every present battery through the class driver's IOCTLs and merges them.
/// Err when the read FAILED — the enumeration found no device while the system power
/// status still reports a battery — so the caller falls back instead of believing a
/// "no battery" that Windows contradicts.
pub fn read_battery_snapshot() -> Result<BatterySnapshot, String> {
    let raws = read_battery_raw_all()?;
    Ok(snapshot_from(&raws, read_system_battery_state().as_ref()))
}

/// True when the system power status reports a battery (its BatteryFlag is not the
/// "no system battery" 128 nor the "unknown" 255).
fn system_power_status_says_battery() -> bool {
    unsafe {
        let mut s: SYSTEM_POWER_STATUS = std::mem::zeroed();
        if GetSystemPowerStatus(&mut s) == 0 {
            return false; // the call failed: it contradicts nothing
        }
        s.BatteryFlag != 128 && s.BatteryFlag != 255
    }
}

/// The device paths of the present battery class devices, by enumeration.
fn battery_device_paths() -> Vec<String> {
    // GUID_DEVICE_BATTERY (batclass.h)
    const GUID_DEVICE_BATTERY: windows_sys::core::GUID = windows_sys::core::GUID {
        data1: 0x7263_1E54,
        data2: 0x78A4,
        data3: 0x11D0,
        data4: [0xBC, 0xF7, 0x00, 0xAA, 0x00, 0xB7, 0xB3, 0x2A],
    };
    let mut paths = Vec::new();
    unsafe {
        let set: HDEVINFO = SetupDiGetClassDevsW(
            &GUID_DEVICE_BATTERY,
            std::ptr::null(),
            std::ptr::null_mut(),
            DIGCF_PRESENT | DIGCF_DEVICEINTERFACE,
        );
        if set == -1isize || set == 0 {
            return paths;
        }
        let mut index: u32 = 0;
        loop {
            let mut ifdata: SP_DEVICE_INTERFACE_DATA = std::mem::zeroed();
            ifdata.cbSize = std::mem::size_of::<SP_DEVICE_INTERFACE_DATA>() as u32;
            if SetupDiEnumDeviceInterfaces(set, std::ptr::null(), &GUID_DEVICE_BATTERY, index, &mut ifdata) == 0 {
                break; // no more interfaces (or the enumeration failed)
            }
            index += 1;
            // the size of the detail data, then the detail data itself
            let mut needed: u32 = 0;
            if SetupDiGetDeviceInterfaceDetailW(set, &ifdata, std::ptr::null_mut(), 0, &mut needed, std::ptr::null_mut()) == 0
                && needed == 0
            {
                continue;
            }
            let mut buf = vec![0u8; needed as usize];
            let detail = buf.as_mut_ptr() as *mut SP_DEVICE_INTERFACE_DETAIL_DATA_W;
            (*detail).cbSize = std::mem::size_of::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>() as u32;
            let mut returned: u32 = 0;
            if SetupDiGetDeviceInterfaceDetailW(set, &ifdata, detail, needed, &mut returned, std::ptr::null_mut()) != 0 {
                let path_ptr = (*detail).DevicePath.as_ptr();
                let mut len = 0usize;
                while *path_ptr.add(len) != 0 {
                    len += 1;
                }
                paths.push(String::from_utf16_lossy(std::slice::from_raw_parts(path_ptr, len)));
            }
        }
        SetupDiDestroyDeviceInfoList(set);
    }
    paths
}

fn read_battery_raw_all() -> Result<Vec<RawBattery>, String> {
    let mut raws = Vec::new();
    for path in battery_device_paths() {
        let name = wide(&path);
        let h = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null_mut(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };
        if h.is_null() || h == INVALID_HANDLE_VALUE {
            continue; // this battery could not be opened; try the others
        }
        let raw = read_battery_raw_with_handle(h);
        unsafe { CloseHandle(h) };
        if let Some(raw) = raw {
            raws.push(raw);
        }
    }
    if raws.is_empty() && system_power_status_says_battery() {
        // The enumeration found nothing to talk to while Windows still reports a
        // battery: the native read failed, and this must NOT be answered as a trusted
        // "no battery" (the panel, the benchmark's power line and the compute choice
        // would all believe it).
        return Err("the battery enumeration found no device while the system reports one".to_string());
    }
    Ok(raws)
}

fn read_battery_raw_with_handle(h: *mut core::ffi::c_void) -> Option<RawBattery> {
    // 1. the tag: 0 means no battery is present
    let mut tag_out = 0u32;
    let query_tag = BatteryQueryTag { waitable: 0 };
    let tag_bytes = unsafe {
        std::slice::from_raw_parts(
            (&query_tag as *const BatteryQueryTag) as *const u8,
            std::mem::size_of::<BatteryQueryTag>(),
        )
    };
    let mut tag_buf = tag_out.to_ne_bytes();
    match battery_ioctl(h, IOCTL_BATTERY_QUERY_TAG, tag_bytes, &mut tag_buf) {
        Ok(n) if n as usize >= std::mem::size_of::<u32>() => tag_out = u32::from_ne_bytes(tag_buf),
        _ => return None,
    }
    if tag_out == 0 {
        return None;
    }
    // 2. the information: full-charged capacity (mWh, unless the battery reports %).
    // Some class drivers answer with more than the BATTERY_INFORMATION struct (a
    // trailing word), so the buffer is larger and the first `size_of` bytes are taken.
    let mut information = BatteryInformation::default();
    {
        let qi = BatteryQueryInformation { battery_tag: tag_out, information_level: BATTERY_INFORMATION_LEVEL, at_rate: 0 };
        let qi_bytes = unsafe {
            std::slice::from_raw_parts(
                (&qi as *const BatteryQueryInformation) as *const u8,
                std::mem::size_of::<BatteryQueryInformation>(),
            )
        };
        let mut out = [0u8; 48];
        match battery_ioctl(h, IOCTL_BATTERY_QUERY_INFORMATION, qi_bytes, &mut out) {
            Ok(n) if n as usize >= std::mem::size_of::<BatteryInformation>() => {
                information = unsafe { std::ptr::read_unaligned(out.as_ptr() as *const BatteryInformation) };
            }
            _ => {} // the full capacity stays unknown
        }
    }
    // 3. the status: power state, remaining capacity, voltage, rate. Some class
    // drivers answer this query with success and NO bytes: the battery keeps its tag
    // (it is there) and its status stays unreadable — the system battery state fills
    // the figures in later, instead of the battery vanishing from the app.
    let mut status: Option<BatteryStatus> = None;
    {
        let qs = BatteryQueryStatus { battery_tag: tag_out, timeout: 0 };
        let qs_bytes = unsafe {
            std::slice::from_raw_parts(
                (&qs as *const BatteryQueryStatus) as *const u8,
                std::mem::size_of::<BatteryQueryStatus>(),
            )
        };
        let mut st = BatteryStatus::default();
        let out_bytes = unsafe {
            std::slice::from_raw_parts_mut(
                (&mut st as *mut BatteryStatus) as *mut u8,
                std::mem::size_of::<BatteryStatus>(),
            )
        };
        if matches!(
            battery_ioctl(h, IOCTL_BATTERY_QUERY_STATUS, qs_bytes, out_bytes),
            Ok(n) if n as usize >= std::mem::size_of::<BatteryStatus>()
        ) {
            status = Some(st);
        }
    }
    Some(RawBattery { tag: Some(tag_out), information: Some(information), status })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(tag: Option<u32>, info: Option<BatteryInformation>, status: Option<BatteryStatus>) -> RawBattery {
        RawBattery { tag, information: info, status }
    }

    fn info(full: u32, capabilities: u32) -> BatteryInformation {
        BatteryInformation { full_charged_capacity: full, capabilities, ..Default::default() }
    }

    fn status(power_state: u32, capacity: u32, voltage: u32, rate: i32) -> BatteryStatus {
        BatteryStatus { power_state, capacity, voltage, rate }
    }

    #[test]
    fn no_battery_is_present_false_with_no_figures() {
        // no device at all
        let s = battery_snapshot(&raw(None, None, None));
        assert!(!s.present);
        assert_eq!(s.on_mains, None);
        assert_eq!(s.remaining_mwh, None);
        // a device whose tag is 0 (Windows' way of saying no battery is present)
        let s = battery_snapshot(&raw(Some(0), Some(info(45890, 0)), Some(status(0, 0, 0, 0))));
        assert!(!s.present);
    }

    #[test]
    fn a_discharging_battery_reports_its_draw_in_mw() {
        // the class driver's rate is negative while discharging: the draw is its negation
        let s = battery_snapshot(&raw(
            Some(1),
            Some(info(45890, 0)),
            Some(status(BATTERY_DISCHARGING, 20760, 12870, -8500)),
        ));
        assert!(s.present);
        assert_eq!(s.on_mains, Some(false));
        assert_eq!(s.discharging, Some(true));
        assert_eq!(s.remaining_mwh, Some(20760));
        assert_eq!(s.full_mwh, Some(45890));
        assert_eq!(s.discharge_mw, Some(8500));
        assert_eq!(s.voltage_mv, Some(12870));
    }

    #[test]
    fn on_the_mains_there_is_no_draw_figure() {
        // a positive rate on the mains is a charge, not a draw: no figure, never a 0
        let s = battery_snapshot(&raw(
            Some(1),
            Some(info(45890, 0)),
            Some(status(BATTERY_POWER_ONLINE, 40000, 12870, 12000)),
        ));
        assert!(s.present);
        assert_eq!(s.on_mains, Some(true));
        assert_eq!(s.discharging, Some(false));
        assert_eq!(s.discharge_mw, None);
    }

    #[test]
    fn a_discharging_pack_with_a_zero_or_positive_rate_has_no_draw_figure() {
        // the discharging bit is set but the rate says charging or nothing: never a fabricated 0
        let zero = battery_snapshot(&raw(
            Some(1),
            Some(info(45890, 0)),
            Some(status(BATTERY_DISCHARGING, 20760, 12870, 0)),
        ));
        assert_eq!(zero.discharging, Some(true));
        assert_eq!(zero.discharge_mw, None);
        let positive = battery_snapshot(&raw(
            Some(1),
            Some(info(45890, 0)),
            Some(status(BATTERY_DISCHARGING, 20760, 12870, 8500)),
        ));
        assert_eq!(positive.discharge_mw, None);
    }

    #[test]
    fn an_unknown_rate_is_null_never_zero() {
        let s = battery_snapshot(&raw(
            Some(1),
            Some(info(45890, 0)),
            Some(status(BATTERY_DISCHARGING, 20760, 12870, BATTERY_UNKNOWN_RATE)),
        ));
        assert!(s.present);
        assert_eq!(s.discharge_mw, None);
    }

    #[test]
    fn an_unknown_capacity_or_voltage_is_null_or_no_reading() {
        // unknown remaining capacity: as parseBattery, this is no usable reading
        let s = battery_snapshot(&raw(
            Some(1),
            Some(info(45890, 0)),
            Some(status(BATTERY_DISCHARGING, BATTERY_UNKNOWN_CAPACITY, 12870, -8500)),
        ));
        assert!(!s.present);
        // unknown voltage: the reading stands, the voltage stays null
        let s = battery_snapshot(&raw(
            Some(1),
            Some(info(45890, 0)),
            Some(status(BATTERY_DISCHARGING, 20760, BATTERY_UNKNOWN_VOLTAGE, -8500)),
        ));
        assert!(s.present);
        assert_eq!(s.voltage_mv, None);
    }

    #[test]
    fn a_relative_capacity_battery_reports_no_mwh() {
        // capabilities say the capacity is a percentage, not mWh: the full capacity stays null,
        // and the milliwatt rate is not usable either. The value is the SDK's LITERAL
        // (poclass.h: BATTERY_CAPACITY_RELATIVE 0x40000000), deliberately not the Rust
        // constant, so a wrong implementation constant cannot make this test pass.
        const SDK_BATTERY_CAPACITY_RELATIVE: u32 = 0x4000_0000;
        let s = battery_snapshot(&raw(
            Some(1),
            Some(info(87, SDK_BATTERY_CAPACITY_RELATIVE)),
            Some(status(BATTERY_DISCHARGING, 45, 0, -8500)),
        ));
        assert!(s.present);
        assert_eq!(s.remaining_mwh, Some(45));
        assert_eq!(s.full_mwh, None);
        assert_eq!(s.discharge_mw, None);

        // A real sealed pack reports the flag together with the other capability bits
        // (BATTERY_SEALED 0x10000000 | BATTERY_CAPACITY_RELATIVE 0x40000000): the flag
        // must still be recognized inside a realistic combination.
        let sealed = battery_snapshot(&raw(
            Some(1),
            Some(info(87, 0x5000_0000)),
            Some(status(BATTERY_DISCHARGING, 45, 0, -8500)),
        ));
        assert_eq!(sealed.full_mwh, None, "a sealed relative pack has no mWh full capacity");
        assert_eq!(sealed.discharge_mw, None);
    }

    /// Regression for the 0x40 misreading: 0x40 is not a defined capability flag
    /// (poclass.h defines only 0x1–0x10 and 0x10000000–0x80000000), so a pack whose
    /// capabilities carry it must still be treated as ABSOLUTE-capacity: its full
    /// capacity and its rate are real figures.
    #[test]
    fn the_undefined_0x40_capability_bit_does_not_mean_relative_capacity() {
        let s = battery_snapshot(&raw(
            Some(1),
            Some(info(45890, 0x40)),
            Some(status(BATTERY_DISCHARGING, 20760, 12870, -8500)),
        ));
        assert_eq!(s.full_mwh, Some(45890));
        assert_eq!(s.discharge_mw, Some(8500));
        // And the SDK's other flags alone must not trip the relative path either.
        for caps in [0x8000_0000u32, 0x2000_0000, 0x1000_0000, 0x0000_0010, 0x0000_0002] {
            let s = battery_snapshot(&raw(
                Some(1),
                Some(info(45890, caps)),
                Some(status(BATTERY_DISCHARGING, 20760, 12870, -8500)),
            ));
            assert_eq!(s.full_mwh, Some(45890), "capabilities {caps:#x} are not relative");
            assert_eq!(s.discharge_mw, Some(8500), "capabilities {caps:#x} keep the rate");
        }
    }

    #[test]
    fn the_json_keeps_the_nulls() {
        let s = battery_snapshot(&raw(Some(1), Some(info(45890, 0)), Some(status(BATTERY_DISCHARGING, 20760, 12870, BATTERY_UNKNOWN_RATE))));
        let j = battery_json(&s, 1234);
        assert_eq!(j["present"], json!(true));
        assert_eq!(j["dischargeMW"], Value::Null);
        assert_eq!(j["at"], json!(1234));
        let none = battery_json(&battery_snapshot(&RawBattery { tag: None, information: None, status: None }), 5);
        assert_eq!(none["present"], json!(false));
        assert_eq!(none["remainingMWh"], Value::Null);
    }

    // ---- the merge of several batteries (the pure function; the IOCTLs stay behind
    // the thin raw layer above)

    #[test]
    fn one_battery_merges_to_its_own_figures() {
        let m = merged_battery_snapshot(&[raw(Some(1), Some(info(45890, 0)), Some(status(BATTERY_DISCHARGING, 20760, 12870, -8500)))]);
        assert!(m.present);
        assert_eq!(m.on_mains, Some(false));
        assert_eq!(m.discharging, Some(true));
        assert_eq!(m.remaining_mwh, Some(20760));
        assert_eq!(m.full_mwh, Some(45890));
        assert_eq!(m.discharge_mw, Some(8500));
    }

    #[test]
    fn two_batteries_are_summed() {
        let m = merged_battery_snapshot(&[
            raw(Some(1), Some(info(45890, 0)), Some(status(BATTERY_DISCHARGING, 20760, 12870, -4000))),
            raw(Some(2), Some(info(30000, 0)), Some(status(BATTERY_DISCHARGING, 12000, 12870, -4500))),
        ]);
        assert!(m.present);
        assert_eq!(m.remaining_mwh, Some(32760));
        assert_eq!(m.full_mwh, Some(75890));
        assert_eq!(m.discharge_mw, Some(8500));
        // the shared mains state and the first battery's voltage
        assert_eq!(m.on_mains, Some(false));
        assert_eq!(m.voltage_mv, Some(12870));
    }

    #[test]
    fn one_unknown_makes_the_sum_null_never_a_partial_number() {
        // the second battery cannot read its rate: the summed draw is null, the
        // capacities still sum
        let m = merged_battery_snapshot(&[
            raw(Some(1), Some(info(45890, 0)), Some(status(BATTERY_DISCHARGING, 20760, 12870, -4000))),
            raw(Some(2), Some(info(30000, 0)), Some(status(BATTERY_DISCHARGING, 12000, 12870, BATTERY_UNKNOWN_RATE))),
        ]);
        assert!(m.present);
        assert_eq!(m.remaining_mwh, Some(32760));
        assert_eq!(m.full_mwh, Some(75890));
        assert_eq!(m.discharge_mw, None);
        // a battery whose capacity is unreadable gives no usable reading at all (the
        // single-battery conversion finds nothing in it): every sum goes null rather
        // than adding up the batteries that did answer
        let m = merged_battery_snapshot(&[
            raw(Some(1), Some(info(45890, 0)), Some(status(BATTERY_DISCHARGING, 20760, 12870, -4000))),
            raw(Some(2), Some(info(BATTERY_UNKNOWN_CAPACITY, 0)), Some(status(BATTERY_DISCHARGING, BATTERY_UNKNOWN_CAPACITY, 12870, -4500))),
        ]);
        assert!(m.present);
        assert_eq!(m.remaining_mwh, None);
        assert_eq!(m.full_mwh, None);
        assert_eq!(m.discharge_mw, None);
    }

    #[test]
    fn no_battery_present_is_present_false_with_no_figures() {
        let m = merged_battery_snapshot(&[]);
        assert!(!m.present);
        assert_eq!(m.on_mains, None);
        assert_eq!(m.remaining_mwh, None);
        // a device that answered tag 0 (Windows' "no battery is present") counts as none
        let m = merged_battery_snapshot(&[raw(Some(0), Some(info(45890, 0)), Some(status(BATTERY_DISCHARGING, 20760, 12870, -8500)))]);
        assert!(!m.present);
    }

    #[test]
    fn a_tagged_battery_whose_status_failed_is_present_with_unknown_figures() {
        // the battery is THERE (it answered with a tag): the figures stay null, the
        // battery is not reported as absent
        let m = merged_battery_snapshot(&[raw(Some(1), None, None)]);
        assert!(m.present);
        assert_eq!(m.on_mains, None);
        assert_eq!(m.remaining_mwh, None);
        assert_eq!(m.discharge_mw, None);
    }

    // ---- the system battery state fills what the status query did not answer

    #[test]
    fn the_system_battery_state_fills_the_figures_the_status_did_not_give() {
        // a tagged battery whose status the driver answers with success and no bytes
        // (this PC's class driver does): the figures come from the system-wide read
        let raws = [raw(Some(1), Some(info(71040, 0)), None)];
        let sys = SystemBatteryRaw {
            ac_online: false,
            present: true,
            discharging: true,
            max_capacity: 71040,
            remaining_capacity: 20602,
            rate: 8511u32.wrapping_neg(), // negative while discharging, as the drivers sign it
        };
        let s = snapshot_from(&raws, Some(&sys));
        assert!(s.present);
        assert_eq!(s.on_mains, Some(false));
        assert_eq!(s.discharging, Some(true));
        assert_eq!(s.remaining_mwh, Some(20602));
        assert_eq!(s.full_mwh, Some(71040));
        assert_eq!(s.discharge_mw, Some(8511));
        // no voltage in the system state: null, never a fabricated 0
        assert_eq!(s.voltage_mv, None);
    }

    #[test]
    fn the_system_battery_state_without_a_battery_fills_nothing() {
        let raws = [raw(Some(1), Some(info(71040, 0)), None)];
        let sys = SystemBatteryRaw { ac_online: true, present: false, discharging: false, max_capacity: 0, remaining_capacity: 0, rate: 0 };
        let s = snapshot_from(&raws, Some(&sys));
        assert!(s.present);
        assert_eq!(s.remaining_mwh, None);
        assert_eq!(s.discharge_mw, None);
    }

    #[test]
    fn the_system_battery_state_never_replaces_a_figure_read_per_battery() {
        // the status read fine: the per-battery figures stand untouched
        let raws = [raw(Some(1), Some(info(45890, 0)), Some(status(BATTERY_DISCHARGING, 20760, 12870, -4000)))];
        let sys = SystemBatteryRaw { ac_online: false, present: true, discharging: true, max_capacity: 99999, remaining_capacity: 88888, rate: 11111u32.wrapping_neg() };
        let s = snapshot_from(&raws, Some(&sys));
        assert_eq!(s.remaining_mwh, Some(20760));
        assert_eq!(s.full_mwh, Some(45890));
        assert_eq!(s.discharge_mw, Some(4000));
        assert_eq!(s.voltage_mv, Some(12870));
    }

    #[test]
    fn the_system_battery_state_of_a_charging_or_unknown_rate_gives_no_draw() {
        let raws = [raw(Some(1), None, None)];
        // charging (positive rate) on the AC: no draw figure
        let sys = SystemBatteryRaw { ac_online: true, present: true, discharging: false, max_capacity: 71040, remaining_capacity: 30000, rate: 2500 };
        let s = snapshot_from(&raws, Some(&sys));
        assert_eq!(s.discharge_mw, None);
        assert_eq!(s.on_mains, Some(true));
        // the unknown-rate marker (0x80000000): no figure, never 0
        let sys = SystemBatteryRaw { ac_online: false, present: true, discharging: true, max_capacity: 71040, remaining_capacity: 30000, rate: BATTERY_UNKNOWN_RATE as u32 };
        let s = snapshot_from(&raws, Some(&sys));
        assert_eq!(s.discharge_mw, None);
    }

    /// The live check on this PC (a laptop, unplugged): the native read must agree with
    /// WMI's BatteryStatus read within seconds of it. Run with
    /// `cargo test --manifest-path src-tauri/Cargo.toml live_battery -- --ignored --nocapture`.
    #[test]
    #[ignore = "reads the real battery of this PC; run beside a WMI read, unplugged"]
    fn live_battery_reading() {
        let j = read_battery_json().expect("the native battery read failed");
        println!("native: {}", serde_json::to_string_pretty(&j).unwrap());
        assert_eq!(j["present"], json!(true), "this PC has a battery: it must be found");
        let remaining = j["remainingMWh"].as_u64().expect("a remaining capacity");
        let full = j["fullMWh"].as_u64().expect("a full capacity");
        let discharge = j["dischargeMW"].as_i64().expect("a discharge rate while unplugged");
        println!("native: remaining {} mWh / full {} mWh / discharge {} mW", remaining, full, discharge);
    }
}
