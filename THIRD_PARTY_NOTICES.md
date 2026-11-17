# MKMN attribution and runtime terms

MKMN is an independently branded derivative of
[Open-NPU](https://github.com/disposablecameraapp/Open-NPU).
The original **Copyright (c) 2026 Open NPU contributors** and MIT license
are retained verbatim in `LICENSE`, beside MKMN's own copyright: MKMN is
open source under the same MIT License. MKMN is an independent project, not
affiliated with any company or organization, and includes no third-party logos
or proprietary symbols.

Tauri v2, Node.js, React, Vite, TypeScript, KaTeX, Mermaid, Puck, PDF.js,
sherpa-onnx, ONNX Runtime and other bundled dependencies retain their
respective licenses. Run `pnpm run licenses` after a full native installation
to regenerate `THIRD_PARTY_LICENSES.txt` for the installed dependency graph;
the Windows installer carries that file beside `LICENSE` and this one. The shipped
build is Tauri v2 (Rust host + WebView2 + Node sidecar). Chromium-derived code inside
bundled dependencies keeps its notices in `THIRD_PARTY_LICENSES.txt`.

Qualcomm GenieX, QNN/QAIRT, NPU drivers, Microsoft Foundry Local,
llama.cpp binaries, and downloaded language/speech models are external
runtime dependencies. They are not relicensed by MKMN. Obtain them from
their legitimate publishers and comply with each component/model license.
GenieX is not included in this source distribution.

The multilingual search model for project files,
[paraphrase-multilingual-MiniLM-L12-v2](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2)
(Apache-2.0; the q8 ONNX conversion published as `Xenova/paraphrase-multilingual-MiniLM-L12-v2`),
is not shipped: it is downloaded only when the person installs it from
Settings → Files & projects, from one pinned revision whose files' SHA-256 are
checked. It runs on ONNX Runtime (`onnxruntime-node`, MIT), whose Windows ARM64
binaries ship with the sidecar.

The retained upstream source link in package metadata and legal notices
is attribution, not an MKMN update channel. Automatic updates are disabled.
Dependency notice collection is a practical aid, not a complete legal review.
