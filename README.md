# MKMN AI | مكمن

MKMN runs language models on your laptop's NPU instead of a data centre. It is a
Windows 11 desktop app for Snapdragon X (ARM64) PCs: chats, answers from your own
files, Word, Excel and PowerPoint files, small programs and voice conversations
are handled by a model on the Qualcomm Hexagon NPU through GenieX, and your files
and chats are stored on the PC. HUMAIN Fuse and HUMAIN Node are there when you
choose a cloud model for a chat; that chat's messages and attachments then go to
the provider you picked.

The name comes from *makman* (مكمن), Arabic for a reservoir. The app is a
**Tauri v2** host (Rust + WebView2) with a plain-Node sidecar and a React window.

**Release status: v0.0.1**, the initial public release
([release notes](docs/releases/RELEASE_NOTES_v0.0.1.md)).

NPU execution is a runtime observation on each device, not a guarantee for every
device or model. The app shows where each model really ran.

## What it does

- **Runs models on the NPU, and says where they really ran.** Each model is
  badged NPU, Hybrid (part on the CPU) or CPU. Hybrid and CPU are never picked
  silently: they need **Allow part-CPU loading** in Settings → Models. A model
  whose load test failed on this PC is left out of the list, and benchmark
  results show on each model's row.
- **Dynamic model packs.** Five packs, from 2B to 24B, each a set of models plus
  a small router (Qwen3-0.6B, about 0.4 GB) that reads a request and sends it to
  the right model of the pack. The router runs on the CPU, and moves to the GPU
  when the CPU is too busy, so the NPU stays free for the chat model.
- **Two engines, one at a time.** Qualcomm GenieX (v0.11.0 or newer) by default;
  Microsoft Foundry Local as a second engine with a side-by-side comparison.
  Only one engine holds the NPU at a time, and a model is released before the
  next one loads.
- **Answers from your files, with the source.** A project's files are searched
  on the device (keyword search, plus an optional multilingual model for
  questions worded differently or asked in another language), and answers cite
  the passage they used. A citation to a passage the model never received is
  flagged. Scanned PDF pages are read with on-device OCR.
- **Word, Excel and PowerPoint without Office.** The model writes text; MKMN
  turns it into real .docx, .xlsx and .pptx files, calculates Excel formulas
  itself, and opens existing Office, OpenDocument and RTF files. A new deck is
  planned slide by slide, charted only from figures you gave, and each slide is
  checked before it is kept.
- **Charts, diagrams, quizzes and sheets drawn in the chat** (Mermaid, KaTeX),
  checked once the answer is written and sent back to the model when they would
  not draw.
- **Programs built in steps.** A request for a game or tool is planned as
  small units, each written, run and corrected on its own, then the page is
  played in a sandbox before you see it. Every file keeps its earlier versions.
- **Voice.** Dictation (Whisper) and voice chat read aloud (Kokoro) that you
  can interrupt by speaking. Typed replies are read aloud only when you ask.
- **Computer Use.** You pick one window; the model can click, fill fields and
  choose options there, but has no keyboard, so it can prepare a message and
  never send it. Each step is checked against the window afterwards.
- **Long chats keep going.** Older messages are summarized in the background
  once a chat fills 65 % of the model's window.
- **Projects and scheduled tasks**, and requests in English or Arabic.
- **No self-update and no analytics.** Install new versions yourself. The
  internet is used for downloads you start (models, GenieX, voice models),
  Qualcomm's GenieX release feed during setup and when you check for updates,
  the cloud chats you choose, and Chart.js on generated pages that draw charts.

See the [user guide](docs/guide/user-guide.md) for how to use each part.

## Requirements

Everything below is either inside the installer or installed from the internet
the first time it is needed. Settings → Developer → Requirements shows each one,
whether it is there now, and an Install button for the packages.

| Requirement | Needed for | How it gets there |
| --- | --- | --- |
| Windows 11 (build 22000 or later) on ARM64 | **Required** | The installer refuses any other PC before it writes a file |
| Microsoft Edge WebView2 Runtime | **Required**: draws the window | Part of Windows 11; when Windows has none, the installer downloads Microsoft's bootstrapper, checks its signature and installs it |
| Node runtime and the app's code | **Required**: the sidecar | Inside the installer |
| Speech runtime (sherpa-onnx, ARM64) | Dictation, read-aloud | Inside the installer |
| Qualcomm GenieX **v0.11.0 or newer** | **Required for local inference**: runs models on the NPU | Setup offers it at launch when GenieX is missing, older than v0.11.0 or reports no valid version. It downloads the Windows ARM64 installer listed in Qualcomm's stable release feed, checks its published SHA-256 and signature, and rechecks the installed version before inference is allowed. Skipping leaves local inference off; the rest of the app opens |
| Qualcomm NPU driver | **Required** for the NPU | Comes with Windows Update |
| A chat model (and the router model for Dynamic) | **Required for local inference** | Downloaded from the Models library (Hugging Face, Qualcomm AI Hub, ModelScope, Docker Hub) or with a Dynamic pack |
| Voice models and read-aloud voices | Dictation, voice chat | First-run setup, or the one-click voice install card |
| Microsoft Foundry Local | Optional second engine | Install button (winget `Microsoft.FoundryLocal`) |
| Python | Optional: running Python programs, the benchmark's code checks | Install button (winget `Python.Python.3.12`) |
| LibreOffice | Optional: old .doc/.xls/.ppt, saving as OpenDocument or PDF | Install button (winget `TheDocumentFoundation.LibreOffice`) |
| Windows OCR language pack | Optional: scanned PDF pages in a language Windows has no OCR for | Windows Settings → Language |

Generated web pages that use Chart.js load it from its CDN, so they need the
internet to draw charts.

## Install

1. Download
   [`MKMN-0.0.1-arm64-Setup.exe`](https://github.com/zzahed/MKMN/releases/download/v0.0.1/MKMN-0.0.1-arm64-Setup.exe)
   from the [v0.0.1 release](https://github.com/zzahed/MKMN/releases/tag/v0.0.1)
   (SHA-256 `5e58ca97fd7d85cd671f56e1e534ca94c0082ccdc8e72973160c2941de5bc8ea`),
   or build it yourself (below).
2. Close any running MKMN and run the installer. It installs `MKMN.exe` with a
   `Runtime\` folder (the Node sidecar and its runtime) next to it and creates
   the shortcuts.
3. Start MKMN. First-run setup checks GenieX, asks before downloading anything
   that is missing, and offers the voice models. Choose **Skip local setup** to
   use cloud chat only.
4. Open Settings → Models, install a model and click **Use**.

The installer is not code-signed, so Windows SmartScreen will warn about it.
Do not disable SmartScreen or enterprise controls to install it; follow your
organization's software approval process. Uninstalling keeps your MKMN profile
data. MKMN does not update itself.

## Configure

No `.env` file or secret is needed to build, test or run MKMN.

- **Local models.** Settings → Models lists what can run on this PC. Settings →
  Speed & memory holds the execution mode, model retention and warm-up options.
- **Cloud chat (optional).** Open the AI status panel at the bottom of the chat
  sidebar and use **Chat location** to switch between **Local · This PC**,
  **Cloud · HUMAIN Fuse** and **Cloud · HUMAIN Node**. Enter each provider's
  API key under **Cloud Intelligence** in Settings, click **Save key**, then
  **Test connection and load models**. Keys are protected with Windows DPAPI
  for your Windows account, are never read from the repository, and are left
  out of settings exports. A cloud chat sends its conversation and attachments
  to the provider you selected, and to no one else.
- **Where data lives.** Settings are in `%LOCALAPPDATA%\MKMN`, chats and
  workspace data in `%APPDATA%\MKMN`. Models already managed by GenieX stay
  where GenieX keeps them.

These environment variables are optional overrides for development; leave them
unset for normal use:

| Variable | Effect |
| --- | --- |
| `MKMN_ARM64_LIBS` | Folder holding the ARM64 import libraries (`lib\`) for the Rust build |
| `GENIEX_PATH` | Use this `geniex.exe` instead of the installed one (still version-checked) |
| `GENIEX_DATADIR` | GenieX model cache folder |
| `GENIEX_QAIRT_LIB` | Folder of a QAIRT runtime to pass to GenieX |

## Build and run from source

Build on a Snapdragon X PC running Windows 11. Everything runs natively on ARM64:
an x64 Node or Rust under emulation builds the wrong binaries.

### 1. Tools

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js, Windows ARM64 build | 24 LTS or later | `node -p "process.arch"` must print `arm64` |
| pnpm | 10.26.1 | The lockfile is pnpm's; do not use npm or yarn |
| Rust (rustup) | 1.90 or later | `rustup target add aarch64-pc-windows-msvc` |
| Visual Studio Build Tools | with **MSVC ARM64 build tools** and a **Windows 11 SDK** | Supplies the ARM64 import libraries (see step 3) |
| NSIS | 3 | Only for the installer; `makensis` on the `PATH` or in `Program Files (x86)\NSIS` |

### 2. Get the source

```powershell
git clone https://github.com/zzahed/MKMN.git MKMN
cd MKMN
pnpm --ignore-workspace install --frozen-lockfile
pnpm rebuild esbuild
```

`pnpm` runs install scripts only for `esbuild` (`onlyBuiltDependencies` in
`package.json`); the notice about skipping `onnxruntime-node` is expected.

### 3. Give the Rust build the ARM64 import libraries

The host links with `rust-lld`, which needs one folder holding the ARM64 `.lib`
files: the Windows SDK's `Lib\<version>\um\arm64` and `ucrt\arm64`, and MSVC's
`VC\Tools\MSVC\<version>\lib\arm64` (`msvcrt.lib`, `vcruntime.lib`). Copy them
into a `lib` folder in **one** of these places; the build looks there in this order:

1. `src-tauri\native-sdk\lib`: run
   `.\scripts\setup-arm64-libs.ps1 -Source "C:\path\to\arm64-libs"` to link it there
   (ignored by Git)
2. `$env:MKMN_ARM64_LIBS\lib`
3. `%USERPROFILE%\.arm64-libs\lib`

When none is found, `cargo` prints a warning naming these places and the link fails.

### 4. Check, test and run

```powershell
pnpm typecheck                # renderer and sidecar
pnpm test                     # Vitest suites
cargo test --manifest-path src-tauri\Cargo.toml
pnpm start                    # builds the sidecar and opens the app with tauri dev
```

The app needs GenieX v0.11.0 or newer for local models, as the installed app does.
`pnpm dev:renderer` serves the window alone in a browser; it shows only a
"desktop runtime required" card, because the interface runs inside the desktop app.

### 5. Build the installer

```powershell
pnpm dist                     # same as: .\scripts\Build-Windows.ps1
```

The script checks the tools above, then installs the locked dependencies, type-checks,
runs the tests (`-SkipTests` skips them), regenerates `THIRD_PARTY_LICENSES.txt`,
builds the renderer, the sidecar and the Rust host, runs the Rust tests, copies a
Node runtime and the sidecar's dependencies next to it (`Bundle-Sidecar.ps1`),
runs `makensis`, and finally `Validate-Installer.ps1 -Release`, which unpacks the
installer read-only and checks that every packaged file is the one just built.

To run only the packaging step after the earlier steps have been built:

```powershell
makensis /DVERSION=$(node -p "require('./package.json').version") installer.nsi
```

Output: `dist\MKMN-<version>-arm64-Setup.exe`, with one log per step and a summary
in `dist\build-logs\build.result.json`. The script starts its helper scripts with
`-ExecutionPolicy Bypass` for that process only; it never changes the machine or
user execution policy.

The manual `.github/workflows/release.yml` builds the app on a Windows ARM64
runner and uploads the installer as a CI artifact only. It does not push tags,
create GitHub releases, sign code, or validate hardware inference.

## Project layout

| Path | What is there |
| --- | --- |
| `src/core` | Logic shared by the sidecar and the window (chat, build engine, router, office files, knowledge, engines) |
| `src/sidecar` | The plain-Node sidecar the Tauri host runs (`protocol.ts` is its protocol) |
| `src/renderer` | The React window; `tauriBridge.ts` is its bridge to the host |
| `src/shared` | Types, the settings schema, the path layout (`paths.ts`), the state machine registry |
| `src-tauri` | The Rust host: window, tray, power, supervisor of the model servers, shutdown |
| `tests` | Vitest suites (`pnpm exec vitest run`); Rust tests live beside their code |
| `scripts` | Build, packaging, check and generator scripts |
| `docs` | Documentation, organized by kind: see [docs/README.md](docs/README.md) |
| `build`, `crates`, `installer.nsi` | Icons and configurator page, the patched Windows resource crate, the NSIS installer script |

The Tauri host (Rust) owns the window, tray, power management and the GenieX
model-server process; the supervised sidecar carries the TypeScript logic
(catalog, installs, chat orchestration, voice, sandbox, scheduled tasks).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the checks to run and the rules the
test suite enforces. Do not add personal profiles, documents, credentials or
model weights to the repository.

## Brand assets

The name, logo, palette and the rules for privacy and offline claims are in
[docs/design/BRAND.md](docs/design/BRAND.md). The SVG masters are
`build/mkmn-*.svg`; `node scripts/generate-brand-assets.mjs` makes every icon
from them. No third-party logo or proprietary symbol is used.

## License

MIT; see [LICENSE](LICENSE). MKMN is derived from
[Open NPU](https://github.com/disposablecameraapp/Open-NPU) (MIT), whose
copyright notice is retained in `LICENSE`. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `THIRD_PARTY_LICENSES.txt`
for dependencies and the terms of external runtimes and models. GenieX, the NPU
driver, Foundry Local and downloaded models are not part of this repository and
keep their publishers' licenses.
