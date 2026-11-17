# MKMN: details moved out of the interface

This guide explains, in plain words, the parts of MKMN that the interface keeps short.

## Local and HUMAIN cloud chat

Open the AI status panel at the bottom of the chat sidebar and use **Chat location**.
When the sidebar is collapsed, open the panel from the title bar.
In Settings, the same control is under **General → Chats & answers → Where chat runs**.
The control is disabled while a reply is in progress.
On first launch, choose **Skip local setup** to configure cloud
chat without installing a local runtime.

Local chat needs Qualcomm GenieX **v0.11.0 or newer**. If GenieX is missing, older, or does
not report a valid version, the setup screen shows the version it found and the version
required, and **Install** gets Qualcomm's latest stable Windows ARM64 release (checked against
its published SHA-256 and signature, then checked again once installed). Until then local
models do not run and a banner says why; cloud chat, Foundry Local and the rest of the app
keep working. The check only runs your installed GenieX, so a PC with a compatible GenieX
works offline. Settings → Developer → Requirements also reports the NPU driver and whether
a chat model is installed.

- **Local · This PC** is the default. Chat inference uses an installed local model
  and can run offline once the model and runtime are installed. It requires no
  HUMAIN key. Downloads and manually submitted HUMAIN API requests are separate.
- **Cloud · HUMAIN Fuse** and **Cloud · HUMAIN Node** send chat to the chosen provider.
  A chat on Fuse goes through MKMN's own pipeline, as a local model does: files and
  programs, checked charts and diagrams, project knowledge, long-chat summaries and the
  per-turn limit all work there. Node still answers on its own simpler path.

### Find your settings

- **General** holds app, chat, and project preferences. **App settings** has a
  separate Appearance card.
- **Local Intelligence** holds Models, Speed & memory, Voice, and Developer tools.
- **Cloud Intelligence** has separate **HUMAIN Fuse** and **HUMAIN Node** pages.
  **Shared cloud tools** holds capabilities, costs, and the API console.
  Settings search shows the destination section and opens the matching controls.
- **About**, the last page, holds app information, updates, and diagnostics.

### Add an API key

1. Click **HUMAIN API keys** beside the selector, or choose **HUMAIN Fuse** or
   **HUMAIN Node** under **Cloud Intelligence** in Settings.
2. Under **HUMAIN Fuse** or **HUMAIN Node**, enter that provider's inference API key
   and click **Save key**.
3. Click **Test connection and load models** and choose a model. The chat model list
   shows chat models only (speech, embedding, image and video models are left out).
   For Node, also select its chat API (Chat Completions, Responses or Messages, as the
   model supports); for Fuse it is always Chat Completions, which MKMN's pipeline uses.
4. Repeat for the other provider if you want both available. Click **Change chat location**
   and select the provider you want to use.

Windows DPAPI protects saved keys for the current Windows account. Keys are
excluded from settings exports. Use **Remove key** in the provider section to
delete the locally saved credential. Cloud requests can send chat history and
attachment content only to the selected provider. Existing backup selections
keep their former primary provider after upgrading.

### Search, thinking, and cost

Open **Cloud Intelligence → HUMAIN Fuse** in Settings and find **Fuse chat options**. Fuse chat can use **Web search**
or **Cited research**: before your message is answered, MKMN asks Fuse to search the web (over its Responses
API, the only place Fuse offers search), gives the findings to the answer, and lists the links it found under
the reply as **Sources**. Hosted web search is a Fuse capability. **Thinking effort** controls Fuse reasoning where the
model supports it. Node-specific reasoning parameters can be sent in a custom
text API request.

In **Shared cloud tools**, use **Chat cost estimates** to enter input and output USD rates per million
tokens for a fixed provider model. MKMN estimates cost when the response includes
both counts. It skips automatic routes and presets, which can use a different
model. Estimates exclude media and other charges.

Use **Enabled capabilities** in **Shared cloud tools** to disable individual operations. The **HUMAIN API console**
includes an image prompt, model picker, and preview/download for PNG results.
Operation templates prefill the endpoint and request JSON. Model pickers show
compatible models first and label entries whose compatibility is unknown. Custom requests
can retrieve results and operate on provider file, video, voice, and batch IDs.

### Other HUMAIN APIs

The **HUMAIN API console** accepts provider-native requests for media generation,
speech, transcription, embeddings, reranking, System One, files, and batches supported by each provider. It supports JSON, multipart
uploads, and binary downloads. **Node realtime**, on the **HUMAIN Node** page, provides a WebSocket console
for JSON events. Click **Load Node models** and select a realtime-capable model
independently of your chat model.

The former **Web & pictures** settings included MKMN's web search and Wikimedia
lookup. The **Cloud Intelligence** section provides cloud connections and provider API access.
If your installed app still shows **Web & pictures**, it needs a build containing
the HUMAIN changes.

## Other app features

- **The resource meters (titlebar pills and inspector).** The GPU and NPU meters follow the way Windows Task Manager counts: each shows its busiest engine, never a sum of engines, and the inspector's Engines table lists every engine separately. The System row is the whole machine's measurement, the MKMN row the app's. RAM is private memory (shared pages are not double-counted). A meter that has no working counter shows "N/A" rather than a fake zero, and numbers older than half a minute are shown as unavailable until a fresh reading arrives — opening the inspector fetches one right away. The first pill is an activity estimate from CPU use, not a power measurement; the battery or charger status next to it is the real one.
- **Dynamic packs.** Pick the memory of your PC and you get three sizes: Flash (smallest, instant), Flux (the reasonable one) and Forge (the biggest your NPU holds). Each size is a pack of models, each the best at one job: code, a natural mail, facts, reasoning. Install a pack and every request goes to the right model of it.
- **Recommended models.** The tested models worth the download on this kind of PC. A model tested on both engines is shown once, on the faster one. Measured on a Snapdragon X Plus; a gap of a few points is not a ranking.
- **Not tested models.** They may work very well, but nobody measured them.
- **Which models are listed.** The Models list shows what can work on this PC. Every chat model installed in GenieX appears, also one you installed outside MKMN. A model whose load test failed here is left out (MKMN tests a model it does not know once, when it is idle); after a GenieX update it is tried again. From Microsoft Foundry Local only the builds made for the NPU are listed; turn on **Allow part-CPU loading** to see its GPU and CPU builds too. The model you have chosen always stays listed.
- **Benchmark results in Models.** Each model the Benchmark suite finishes shows its measured speed and device on its own row in Models ("Measured here"), for the exact build tested. **Show results in Models** in the suite adds a run made before. A GenieX row with no measurement of its own can show its Foundry Local version's result, labelled **Foundry Local variant**.
- **Read aloud.** A typed reply arrives silently, whether it is new, regenerated or reopened. Click **Read aloud** on a reply to hear it. Replies are spoken by themselves only in a **Voice chat** you start.
- **Project folder.** The assistant can list, open and search files in the folder in every chat of the project. It only reads, cannot leave the folder, and what it opens goes into the model's context window.
- **Document answers.** For a direct ownership question, MKMN looks for a passage that names the parties and states the stake, then quotes it with the file and page or section. If the documents do not establish the stake clearly, MKMN says it could not verify it. A follow-up such as “Is it the other way?” or “Double check” goes back to the documents using the previous question when available.
- **Figures from reports.** When you ask for a figure for a named period (for example “What was net income for Q2 2026?” or “When is the Q3 2026 dividend payable?”), MKMN looks for one sentence in your files that names the company, the period and the value together. If it finds one, it quotes that sentence with the file and page right away, without waiting for the model. If two files give different values for the same period, MKMN quotes both and says they do not agree. If no sentence ties the value to the period, the model answers from the matching pages and is told to say when the documents do not settle it. Rechecks such as “Double check that” look at the source again for your earlier question.
- **Faster document search.** When the words of your question clearly match one part of your files, MKMN sends only that part (and close matches) to the model and skips the extra search step, so the first words arrive sooner. Questions in other words than the files use, in another language than the files, or about several parts at once still get the full search.
- **Search across languages** (Settings → Files & projects, optional, 129 MB). Install it and MKMN searches your project files by meaning when the words of a question do not clearly match them: an Arabic question about English files, or a question in other words than the files use. It runs on the processor, takes a few milliseconds per question, and reads your files on this computer only. Without it, MKMN asks the chat model to write search words, which small models often get wrong. **Remove** asks first and takes search back to keywords.
- **Context and compaction.** Click the context percentage to see the estimated prompt usage and the space reserved for the answer. The prompt includes instructions, recent messages, and excerpts from your files. **Compact** is available when there are older messages to summarize. Usage can be high with a short chat and a large document. Compaction leaves the recent exchange intact, and the original chat and documents stay saved.
- **Interrupted answers.** If the document locator times out, MKMN shows that it is continuing with keyword matches. A model server restart is also shown while it happens. When a response ends in an error, **Try again** resends the original request with its attachments and replaces the failed reply.
- **Tasks.** Tasks run while MKMN runs. A task missed while the app was closed runs once at the next start.
- **Closing the window.** By default, closing the window quits the app. If you want it to stay running in the notification area instead, choose "hide to the notification area" in Settings — that is an explicit choice, remembered.
- **Compute choice.** The app can pick how a request runs — on the NPU, the CPU, or a mix — from what it measured on this PC (speed, memory, what is already loaded). It stays with one choice per request and waits between switches. You can leave it on auto and see why it chose, or pin it to NPU, CPU+NPU, GPU or CPU yourself.
- **Warm up model while typing** (Settings → Speed & memory, off by default). When it is on, MKMN starts loading the chat's model as soon as you type the first character of a message, so less time passes after you press Send. It can use memory and power before you send anything, also for a draft you never send. The composer shows **Warming up <model>…**; if you press Send before it finishes, the message waits for that load and is sent once. If the load fails, the error shows next to the composer with **Retry** (typing more does not try again). Local models only.
- **Switching models.** Click **Use** on a model: a status line says **Starting <model>…** until GenieX lists it, then **Warming up <model>…** while its first answer finishes the load (a large model can take a minute or more). **Cancel** stops that switch only. Your previous choice stays selected until the new model has answered once; if the switch fails or you cancel it, the line says which model stays selected and whether one is loaded. If GenieX does not have the exact build you chose, the error lists what it does have.
- **Removing a model.** The trash button asks **Remove <model>?** first. A model cannot be removed while one is starting, loading or answering: wait, or cancel the switch.
- **GenieX model-load errors.** Expand **Raw message** to see the failed model build, GenieX and QAIRT versions, HTTP response and runtime log lines. Two SDK model-load rejections for the same build, runtime and compute mode pause automatic starts for that combination until a successful retry, a change to the combination, or an MKMN restart. Use **Try again** to make one explicit attempt. If another installed native bundle has already generated on the current runtime in this session, the error names it so you can select it in Models. A CPU or GPU alternative requires choosing an appropriate build and compute setting. MKMN warns about outside processes only when Windows measures NPU activity from them.
- **QAIRT context format.** If the runtime reports an unsupported context format, MKMN shows the bundle’s format and the newest format reported by the active runtime. The model chooser shows that error immediately and keeps the failed model available for an explicit retry after changing to a compatible signed runtime or bundle. To use a separate signed QAIRT runtime, set **Runtime libraries folder** under **Developer → Runtime options** to its library directory. For the verified Snapdragon X2 Elite example, see the Windows acceptance notes.
- **Voice placement.** With enough NPU memory or smaller models, chat, dictation and read-aloud can all run on the NPU. MKMN checks the total before loading.
- **Building files.** Files are built one at a time; each job can use its own model, and the NPU switches models (a few seconds) at most once per job. In the Tauri build pages are NOT run in a hidden window: JavaScript and Python are parsed (syntax check only), no keys are pressed and no buttons are clicked; failures of the written code itself are fixed before you see it.
- **Where files open.** A file written in a chat opens in the right-hand panel by default. Turn "Files beside the chat" off in the chat's Smart functions menu and the panel closes: the next file is saved and its card opens the Files page instead. The choice is remembered for the app.
- **Review model.** A bigger, slower model reads the code and errors and fixes them with small edits. It loads after the answer is written and the writing model returns for the next message.
- **Word, Excel and PowerPoint.** Ask for a Word document, a workbook or a presentation and the assistant writes it as text; Save as makes the real .docx, .xlsx or .pptx. A workbook keeps real formulas (the app calculates them too, so the assistant can read the results). A presentation is made in steps: it picks a theme, writes each slide within short limits, and adds charts and diagrams. In the Tauri build the slides are NOT drawn for checking — there is no screenshot of a slide. The app's own layout measure judges every slide: a slide that fits gets a note that it was not drawn; a slide the measure finds too tight is rewritten and the fix is kept only when the re-measured slide overflows less (a fix that makes it worse is undone), and a fix keeps the timeline, callout, chart or flow it was not sent. Low power fixes each tight slide once; turning it off gives up to two attempts per slide, and while a slide is being written its preview redraws at most once a second. The older Electron build draws and screenshots the slides and looks at the screenshots, and the layout measure feeds the fix there too. Attach a .docx, .xlsx, .pptx, .odt, .ods, .odp or .rtf file and the assistant reads it as text (old .doc, .xls and .ppt need LibreOffice on the PC, or save them in the newer format). Pictures and exact formatting of an attached file are not carried over. When no answer is being written, the Edit button of a file lets you type in its text yourself.
