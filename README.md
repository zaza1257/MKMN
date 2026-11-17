# MKMN AI | مكمن

MKMN is an AI chat app for Windows laptops with a Snapdragon X chip.
It runs AI models on the laptop's NPU (a chip made for AI), not in the cloud.
Your chats and files stay on your PC.

The name comes from *makman* (مكمن), the Arabic word for a reservoir.

**Release status: v0.0.2**, security and reliability fixes
([release notes](docs/releases/RELEASE_NOTES_v0.0.2.md)).

## What you can do with it

- **Chat with an AI model** that runs on your laptop.
- **Ask questions about your own files.** The answer shows which part of the
  file it came from.
- **Make Word, Excel and PowerPoint files.** You do not need Microsoft Office.
- **See charts, diagrams and quizzes** inside the chat.
- **Build small programs and games.** MKMN tests them before you see them.
- **Talk to the AI with your voice**, and hear it answer.
- **Let the AI work in one window you choose.** It can click and fill in
  fields. It cannot type with the keyboard, so it can never send anything.
- **Use English or Arabic.**

You can also choose a cloud model (HUMAIN Fuse or HUMAIN Node) for a chat.
If you do, that chat's messages and files are sent to that provider.

See the [user guide](docs/guide/user-guide.md) for more.

## What you need

- A laptop with a **Snapdragon X** chip.
- **Windows 11** (build 22000 or newer).
- An internet connection the first time, to download an AI model.

MKMN sets up the rest for you. When you start it the first time, it asks
before it downloads anything:

- **GenieX** (version 0.11.0 or newer) from Qualcomm. It runs the models on
  the NPU.
- **An AI model**, from the Models page.
- **Voice models**, if you want to use your voice.

Some extras are optional: Microsoft Foundry Local (a second way to run models),
Python and LibreOffice. You can install them later from
**Settings → Developer → Requirements**.

## Install

1. Download `MKMN-<version>-arm64-Setup.exe` from the
   [latest release](https://github.com/zzahed/MKMN/releases/latest).
2. Double-click the file to install MKMN.
3. Windows may show a warning ("Windows protected your PC"). This happens
   because the installer is not signed. If you trust the file, click
   **More info**, then **Run anyway**. On a work PC, ask your IT team first.
4. Open MKMN. Follow the setup steps on the screen.
5. Go to **Settings → Models**. Pick a model, click **Install**, then
   click **Use**.
6. Start chatting.

To check the download, its SHA-256 is
`5e58ca97fd7d85cd671f56e1e534ca94c0082ccdc8e72973160c2941de5bc8ea`.

**Good to know**

- Each model shows a badge: **NPU** (best), **Hybrid** (part on the CPU) or
  **CPU** (slowest). Hybrid and CPU models are only used if you turn on
  **Allow part-CPU loading** in **Settings → Models**.
- MKMN does not update itself. To update, download and install the new version.
- MKMN does not collect any usage data.
- If you uninstall MKMN, your chats and settings are kept.

## Use a cloud model (optional)

1. Open **Settings → Cloud Intelligence**.
2. Paste your HUMAIN API key. Click **Save key**.
3. Click **Test connection and load models**.
4. In the chat sidebar, open the AI status panel. Under **Chat location**,
   pick **Cloud · HUMAIN Fuse** or **Cloud · HUMAIN Node**.

Your key is stored safely on your PC, protected by your Windows account.

## Where your data is saved

- Settings: `%LOCALAPPDATA%\MKMN`
- Chats and files: `%APPDATA%\MKMN`

## Build and run from source

This part is for developers. You only need it if you want to change the code. Do it on a Snapdragon X
laptop with Windows 11.

### 1. Install the tools

| Tool | Version | Note |
| --- | --- | --- |
| Node.js (Windows **ARM64**) | 24 or newer | `node -p "process.arch"` must print `arm64` |
| pnpm | 10.26.1 | Do not use npm or yarn |
| Rust (rustup) | 1.90 or newer | Then run `rustup target add aarch64-pc-windows-msvc` |
| Visual Studio Build Tools | latest | Add **MSVC ARM64 build tools** and a **Windows 11 SDK** |
| NSIS | 3 | Only needed to make the installer |

### 2. Get the code

```powershell
git clone https://github.com/zzahed/MKMN.git MKMN
cd MKMN
pnpm --ignore-workspace install --frozen-lockfile
pnpm rebuild esbuild
```

A message about skipping `onnxruntime-node` is normal.

### 3. Add the ARM64 library files

The Rust build needs some `.lib` files from Visual Studio and the Windows SDK:

- from the Windows SDK: `Lib\<version>\um\arm64` and `Lib\<version>\ucrt\arm64`
- from MSVC: `VC\Tools\MSVC\<version>\lib\arm64`

Copy them all into one folder named `lib`. Then run:

```powershell
.\scripts\setup-arm64-libs.ps1 -Source "C:\path\to\arm64-libs"
```

Instead, you can put the `lib` folder in `%USERPROFILE%\.arm64-libs\`, or set
`MKMN_ARM64_LIBS` to the folder that holds it.

### 4. Test and run

```powershell
pnpm typecheck
pnpm test
pnpm start
```

`pnpm start` opens the app. You need GenieX 0.11.0 or newer to use local models.

### 5. Make the installer

```powershell
pnpm dist
```

This runs `scripts\Build-Windows.ps1`. It checks your tools, runs the tests,
builds everything and makes `dist\MKMN-<version>-arm64-Setup.exe`.
Logs are in `dist\build-logs`. Add `-SkipTests` to the script to skip the tests.

If you only want to remake the installer from files you already built:

```powershell
makensis /DVERSION=$(node -p "require('./package.json').version") installer.nsi
```

**Tip:** if a test about "state machines" fails on Windows, Git may have changed
the line endings. Run `git config core.autocrlf false`, then check out the
files again.

## Project folders

| Folder | What is inside |
| --- | --- |
| `src/core` | The main logic |
| `src/sidecar` | The Node process the app runs in the background |
| `src/renderer` | The app window (React) |
| `src/shared` | Shared types and settings |
| `src-tauri` | The Rust host: window, tray and model servers |
| `tests` | Tests (`pnpm test`) |
| `scripts` | Build and check scripts |
| `docs` | Documentation ([start here](docs/README.md)) |

## Help and contributing

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before you send a change.
- Do not add personal files, passwords, API keys or model files to the
  repository.
- Brand rules (name, logo, colours) are in [docs/design/BRAND.md](docs/design/BRAND.md).

## License

MKMN uses the MIT license. See [LICENSE](LICENSE).

MKMN is based on [Open NPU](https://github.com/disposablecameraapp/Open-NPU)
(MIT). Its copyright notice is kept in `LICENSE`. Other parts and their
licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
`THIRD_PARTY_LICENSES.txt`. GenieX, the NPU driver, Foundry Local and the AI
models are not part of this project. They keep their own licenses.
