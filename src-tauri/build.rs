use std::fs;

fn main() {
    tauri_build::build();

    // The displayed application version must come from package.json — the single source
    // of the version (scripts/Build-Windows.ps1 stamps the installer from it). Baking it
    // in here keeps the Settings page truthful even when Cargo.toml drifts behind.
    // (Deliberately no serde here: a plain string scan of the first "version" field.)
    let pkg_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("package.json");
    if let Ok(pkg) = fs::read_to_string(&pkg_path)
        && let Some(pos) = pkg.find("\"version\"")
    {
        let rest = &pkg[pos + "\"version\"".len()..];
        if let Some(q1) = rest.find('"')
            && let Some(q2) = rest[q1 + 1..].find('"')
        {
            let v = &rest[q1 + 1..q1 + 1 + q2];
            if !v.is_empty() {
                println!("cargo:rustc-env=MKMN_APP_VERSION={}", v);
            }
        }
    }

    // Ensure the side-by-side Common-Controls 6.0 manifest is present in target dirs
    if let Ok(manifest) = fs::read_to_string("MKMN.exe.manifest") {
        let _ = fs::write("target/release/MKMN.exe.manifest", &manifest);
        let _ = fs::write("target/debug/MKMN.exe.manifest", &manifest);
        let _ = fs::write("target/aarch64-pc-windows-msvc/release/MKMN.exe.manifest", &manifest);
        let _ = fs::write("target/aarch64-pc-windows-msvc/debug/MKMN.exe.manifest", &manifest);
    }

    // Ensure Common-Controls 6.0 comctl32.dll is present in all target dirs for TaskDialogIndirect.
    // The exact WinSxS version directory differs between machines/SDK updates: search for
    // ANY arm64 common-controls payload of the same GUID instead of one hard-coded path,
    // and never silently ignore a copy failure (a missing DLL fails later at load time,
    // far from the cause).
    let mut comctl: Option<Vec<u8>> = None;
    if let Ok(bytes) = fs::read("comctl32.dll") {
        comctl = Some(bytes);
    } else if let Ok(win_sxs) = fs::read_dir(r"C:\Windows\WinSxS") {
        // newest matching payload wins (names sort by version when zero-padded; pick the
        // lexicographically last among the same manifest GUID)
        let mut hits: Vec<std::path::PathBuf> = win_sxs
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with("arm64_microsoft.windows.common-controls_6595b64144ccf1df_"))
                    .unwrap_or(false)
            })
            .collect();
        hits.sort();
        if let Some(dir) = hits.pop()
            && let Ok(bytes) = fs::read(dir.join("comctl32.dll"))
        {
            comctl = Some(bytes);
        }
    }
    match comctl {
        Some(bytes) => {
            for dst in [
                "target/release/comctl32.dll",
                "target/debug/comctl32.dll",
                "target/aarch64-pc-windows-msvc/release/comctl32.dll",
                "target/aarch64-pc-windows-msvc/debug/comctl32.dll",
            ] {
                if let Err(e) = fs::write(dst, &bytes) {
                    println!("cargo:warning=Could not stage comctl32.dll into {:?}: {}", dst, e);
                }
            }
        }
        None => println!(
            "cargo:warning=comctl32.dll was not found next to build.rs or under %WINDIR%\\WinSxS (arm64 common-controls): TaskDialog-based dialogs may fail to load."
        ),
    }

    // The ARM64 import libraries must resolve on ANY machine, never via a personal
    // absolute path. They are expected as a repo-local junction/dir (created once by
    // scripts/setup-arm64-libs.ps1), with environment and per-user fallbacks.
    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let mut lib_dirs: Vec<std::path::PathBuf> = vec![manifest_dir.join("native-sdk").join("lib")];
    if let Ok(from_env) = std::env::var("MKMN_ARM64_LIBS") {
        lib_dirs.push(std::path::PathBuf::from(from_env).join("lib"));
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        lib_dirs.push(std::path::PathBuf::from(profile).join(".arm64-libs").join("lib"));
    }
    match lib_dirs.iter().find(|d| d.is_dir()) {
        Some(dir) => println!("cargo:rustc-link-search=native={}", dir.display()),
        None => println!(
            "cargo:warning=No ARM64 import-library directory found (looked for src-tauri/native-sdk/lib, \
             $MKMN_ARM64_LIBS\\lib, %USERPROFILE%\\.arm64-libs\\lib). Run scripts/setup-arm64-libs.ps1; \
             linking will fail until then."
        ),
    }
}
