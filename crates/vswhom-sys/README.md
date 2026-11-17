# vswhom-sys (local stub)

This is an in-repo **stub replacement** for the `vswhom-sys` crate
(<https://crates.io/crates/vswhom-sys>), selected via `[patch.crates-io]` in
`src-tauri/Cargo.toml`.

## Provenance

- Upstream crate: `vswhom-sys 0.1.3` (probing of Visual Studio / Windows SDK locations).
- This copy is **not** upstream code: both exported C-ABI functions
  (`vswhom_find_visual_studio_and_windows_sdk`, `vswhom_free_resources`) were
  replaced with stubs that always report "nothing found".
- Rationale: SDK discovery is handled explicitly by
  `scripts/setup-arm64-libs.ps1` and the repo-relative
  `src-tauri/.cargo/config.toml` (`-Lnative=native-sdk/lib`) instead of
  per-machine probing, keeping builds reproducible.

## Effect

- `windows_sdk_version` is always `0` and all pointers `null`.
- Consumers (embed-resource / tauri-winres) fall back to the library search
  path provided by the cargo configuration above.

## License

MIT — matching the repository root `LICENSE`. The stub contains no upstream
vswhom/vswhom-sys source code.
