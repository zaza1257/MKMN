# MKMN AI 0.0.1 — Initial public release

MKMN AI is a Windows 11 desktop app for Snapdragon X (ARM64) PCs that runs
language models on the Qualcomm Hexagon NPU through GenieX and keeps your files
and chats on the PC. This is its first public release.

## What ships

- **Local chat on the NPU.** Models are listed with where they run (NPU, Hybrid,
  CPU); part-CPU loading is used only when you allow it. Benchmark and
  load-test results appear on each model's row.
- **Two local engines.** Qualcomm GenieX (v0.11.0 or newer, required for GenieX
  inference) and, optionally, Microsoft Foundry Local. One engine holds the NPU
  at a time.
- **Dynamic model packs** with a small router model that sorts each request.
- **Answers from your files** with cited passages, on-device keyword search, an
  optional multilingual search model, and OCR for scanned PDF pages.
- **Office files without Office**: Word, Excel and PowerPoint files are written
  and read by the app; Excel formulas are calculated by the app.
- **Drawn blocks in the chat**: charts, diagrams, quizzes, checklists, sheets
  and formulas.
- **Programs built in steps**, played in a sandbox before they are shown, with
  versions of every file.
- **Voice**: dictation and an interruptible voice chat.
- **Computer Use**: the model works in one window you pick, without a keyboard.
- **Projects, scheduled tasks, long-chat summaries**, English and Arabic.
- **Optional cloud chat** through HUMAIN Fuse and HUMAIN Node, with your own
  API keys stored under Windows DPAPI.
- **A Windows ARM64 installer**
  ([`MKMN-0.0.1-arm64-Setup.exe`](https://github.com/zzahed/MKMN/releases/download/v0.0.1/MKMN-0.0.1-arm64-Setup.exe),
  attached to the v0.0.1 release) that bundles the
  host, the Node sidecar and the speech runtime, and refuses PCs that are not
  Windows 11 on ARM64.

## Requirements

- Windows 11 (build 22000 or later) on ARM64, with the Qualcomm NPU driver.
- Qualcomm GenieX v0.11.0 or newer for local inference; setup offers to install
  it. Without it, cloud chat and the rest of the app still open.
- At least one chat model, installed from Settings → Models.

## Known limitations

- The installer is not code-signed; Windows SmartScreen will warn about it.
- MKMN does not update itself. Install new versions yourself.
- NPU execution depends on the device, driver and model; the app reports where
  each model really ran.
- The automatic NPU reset is not active in this build; a manual reset is in
  Developer settings.
- The Microsoft Foundry Local speech path is written from its documentation and
  has not been tried against a real install.
- Generated pages that draw charts with Chart.js load it from its CDN.

## Building from source

See the [README](../../README.md#build-and-run-from-source).
