# Why some models do not load on the NPU, and a deep-research prompt

Written on 2026-10-25 from the first test bench (`model testing.zip`, 89 models) and from the logs of the test bench and of the NPU load test. **Facts** = read in our logs or in the cited sources. **Hypotheses** = deductions, to be verified.

## 1. What our logs say

PC: Snapdragon X Plus X1P64100 (10 cores), 15,6 GB of RAM, Windows 26300.9711, NPU driver 10.0.26100.1, GenieX 0.9.3. The server is launched by the app with `--compute npu`: according to the GenieX notes, `npu` pins **the whole model on a single NPU session (HTP0)**.

| Model (file) | Window | Buffers placed on HTP0 (weights + cache + compute) | Rejected buffer |
|---|---|---|---|
| Qwen3-4B-Thinking-2507 (2,3 GB) | 16 384 | ~2,3 GB + cache 2 304 MiB + compute 780 MiB | 622 333 952 B (594 MiB), error 0x200 |
| Ministral-8B-Instruct (4,3 GB) | 2 048 (scale) | ~4,3 GB + cache 288 MiB + compute 724 MiB | 536 875 008 B (512 MiB + 8 KiB), 0x200 |
| Gemma-2-9B-it (5,1 GB) | 3 072 | ~5,1 GB + cache 2 x 504 MiB + compute 1 236 MiB | 1 057 542 144 B (1 009 MiB), 0x200 |

Facts:
- Message: `ggml-hex: HTP0 buffer mapping failed : domain_id 3 size N fd F error 0x00000200`, then `fastrpc_mmap failed`, then the API error `-100201 SDKError(Model loading failed)`.
- `n_ubatch = 1024`, `n_batch = 2048`, `flash_attn = enabled` in our launches. GenieX set `n_ubatch` to 128 under Linux to avoid exactly this kind of failure (GenieX #1503); under Windows it is not changed.
- None of the 14 settings tried (windows 8 192 to 2 048, `GGML_HEXAGON_MBUF`, `GGML_HEXAGON_DEVICES`) made a model load. The size of the rejected buffer does not depend on the window.
- After a failure, the NPU counter can stay at 2 or 3 GB while the server is stopped.
- Many failures are a **server crash** (`fetch failed`, Go panic trace), not a 500 error.
- The Windows counters work ("compute-only" adapter, 0,22 GB at rest): the memory measurements are reliable.

Sources: llama.cpp `docs/backend/snapdragon/README.md` (one NPU session: ~3,5 GB of mapping; beyond that, the weights are mapped dynamically; large models spread over several sessions), llama.cpp #26123 (a shared 4 GB address window, failures below the total budget that suggest fragmentation), x1e-npu (output tensor that cannot be split by `GGML_HEXAGON_MBUF`, a 1 GiB aligned hole is required; a failure can leave the driver in a bad state), GenieX #1531 (same error on a 1 GiB compute buffer with `n_ubatch` 1024), GenieX #1530 (a 64 MiB cap removed under Windows to run Qwen3.5-9B on X Elite).

**Main hypothesis**: it is not the size of the model that matters but what has to be mapped at the same time on the session (weights split into 1 GiB chunks, context cache, compute buffer) and the possibility of finding a **contiguous and aligned** hole for each chunk. The rejected buffer is each time a weight chunk (a remainder or the last one), which fits with mappings that accumulate until exhaustion.

## 2. What ran and what did not run (first bench, same PC)

**Ran to completion on the NPU (30 models)**, including large ones: Qwen3.5-4B, Qwen3-4B-Instruct-2507, Qwen3-8B (4,8 GB), Qwen3.5-9B (5,4 GB), Ministral-3-8B-Reasoning, Ministral-8B-Instruct-2410 (4,3 GB), GLM-4-9B-0414, MiMo-V2.6-Distill-Qwen-9B, Gemma-4-E2B-it, Gemma-3-4B-it, Gemma-3-1B-it, Qwen2.5-Coder-3B and 1.5B, Qwen2.5-1.5B, LFM2 (1.2B, 2.6B), LFM2.5 (1.2B, 2.6B, 8B-A1B), Nemotron-3-Nano-4B (NPU + CPU), Arch-Function-3B, xLAM-2-3B-fc-r, EXAONE-4.0-1.2B, DeepScaleR-1.5B, VibeThinker-3B, Qwen3-1.7B (native NPU bundle), Qwen3-4B-Thinking-2507 (partial).

**Did not load (56 models, with the only repository tried)**, by family:
- **Llama and derivatives**: Llama-3.1-8B, Llama-3.2-3B, Hermes-3-Llama-3.1-8B, Llama-3-Groq-8B-Tool-Use, Llama-xLAM-2-8B, LongWriter-Llama3.1-8B, Llama-3-8B-Finance-RAG, Dolphin3-Cyber-8B, Seed-Coder-8B (2), Yi-Coder-9B, OpenCoder-8B.
- **Gemma 2 and some Gemma 3/4**: Gemma-2-9B-it, SPPO-Iter3, Gemma-4-E4B-it, **MedGemma-4B-it**, **TranslateGemma-4B-it** (gemma3 architecture, like Gemma-3-4B-it which ran).
- **Phi / Granite / OLMo / Hunyuan / InternLM / MiniCPM / Cohere**: Phi-4-mini (2), Granite-4.0-H-Tiny, Granite-4.2-8B, Olmo-3 (2), Hunyuan (4B, 7B, MT-7B), InternLM3-8B, MiniCPM4.1-8B, MiniCPM5-2B, Aya-Expanse-8B, Tiny-Aya.
- **Others**: Apertus, EuroLLM, Salamandra, Falcon3 and Falcon-H1R, EXAONE-Deep-7.8B, SmolLM3, Nemotron-Nano-9B-v2, Nemotron-3.5-Bolt, Seed-X, TwIL, NuExtract (2).
- **Same architecture as models that ran, but failure**: Qwen2.5-7B-Instruct (and 1M), Jan-v1-4B / Jan-nano / Jan-code-4B (Qwen3 base), Qwen3-4B and Qwen3-1.7B "custom" (bartowski GGUF), Ministral-3-8B-Instruct and 3B (the Reasoning one ran).
- Qwen2.5-Coder-7B: rejected by the app (9,2 GB estimated), not tried on the NPU.

## 3. Similarities and differences

1. **Architecture alone is not decisive.** The same architectures appear on both sides (qwen3, gemma3, ministral). So runtime support for the architecture does not explain everything.
2. **The GGUF file matters.** Qwen3-1.7B as a native NPU bundle ran, the "custom" GGUF did not. Gemma-3-4B-it ran, MedGemma-4B and TranslateGemma-4B (same architecture, same size) did not. Hypothesis: the way the GGUF is built (type of the output tensor and of the embedding, `output.weight` separate or shared, mixed quantization Q4_0 + Q6_K/Q8_0, vocabulary size, weight splitting) changes the chunks to be mapped.
3. **The families that run are the ones Qualcomm and the community test the most**: Qwen2.5/3/3.5 (and derivatives), Gemma 3 (1B, 4B), Gemma-4-E2B, LFM2/2.5, Ministral 3 Reasoning, GLM-4. The families that almost all fail (Llama, Gemma-2, Phi, Granite, OLMo, Hunyuan…) have larger vocabularies, tied embeddings or unusual layers (SWA, hybrid): **to be checked in the GGUF files**.
4. **Size is not the criterion**: Qwen3.5-9B (5,4 GB) ran, Qwen3-4B-Thinking (2,3 GB) and MedGemma-4B (2,4 GB) did not. A 5,4 GB model that runs contradicts the idea of a 4 GB limit; the most likely explanation (hypothesis) is that models above about 3,5 GB have their weights mapped dynamically, whereas those of 2 to 3 GB with a large context cache remain mapped in one block.
5. **Things have changed since the first bench.** Qwen3-4B-Thinking and Qwen3.5-4B had run; they now fail on the same PC. To check: GenieX update (0.9.3?), Windows update (Insider build 26300), NPU driver update, or a larger window (16 384). **Simple test to do on the PC**: rerun Qwen3-4B-Instruct-2507 (which had run) with the NPU load test. If it also fails, it is the environment that changed, not the models.

## 4. What the app now does

- The **NPU load test** (Settings, Developer) tries 2 to 4 NPU sessions, smaller weight chunks and smaller windows, **all on NPU**, from the least restrictive to the most restrictive.
- **Hybrid mode** (part of the model on the CPU) is never used on its own. It is tried as a last resort only if the "hybrid" checkbox is ticked, in the test and in the bench. A model that loads only this way is flagged "part on the CPU".
- The setting that works is kept per model, and the app then starts that model with it.

## 5. Deep-research prompt (to copy into Gemini Deep Research)

---

## Mission

I am developing a Windows application (MKMN) that runs local language models on the **Hexagon NPU of a Snapdragon X** via **GenieX** (Qualcomm runtime, llama.cpp "ggml-hexagon" backend, GGUF Q4_0 models). I want two things, with verifiable sources (links, dates, software version):

**A. Understand and fix the load failure.** Many GGUF files do not load on the NPU. I want the exact cause and the simplest fix, **keeping the model entirely on the NPU** (hybrid NPU + CPU mode is a last resort, not the solution).

**B. Find models that really have a good chance of loading on the NPU alone**, with their characteristics, and the Hugging Face repositories of Q4_0 GGUF files whose file loads.

## The facts, taken from our logs

- Hardware: Snapdragon X Plus X1P64100 (10 cores), 15,6 GB of RAM, Windows 11 build 26300.9711 (Insider), NPU driver 10.0.26100.1, GenieX 0.9.3 (CLI v0.9.3), server launched with `geniex serve --compute npu --nctx N` (so everything pinned on the `HTP0` session), `n_ubatch=1024`, `n_batch=2048`, `flash_attn` enabled.
- Exact error, always the same: `ggml-hex: HTP0 buffer mapping failed : domain_id 3 size <N> fd <F> error 0x00000200`, then `creating llm error: ggml-hex: fastrpc_mmap failed (see log for details)`, then the API returns 500 `{"code":-100201,"error":"SDKError(Model loading failed)"}`. Sometimes, instead, the server crashes (Go panic in gin) and the client sees `fetch failed`.
- Sizes of rejected buffers: 622 333 952 B (Qwen3-4B-Thinking, 2,3 GB file, window 16 384, KV cache 2 304 MiB, compute buffer 780 MiB), 536 875 008 B (Ministral-8B, 4,3 GB, window 2 048, KV 288 MiB, compute 724 MiB), 1 057 542 144 B (Gemma-2-9B, 5,1 GB, window 3 072, KV 2 x 504 MiB, compute 1 236 MiB). Reducing the window to 2 048, setting `GGML_HEXAGON_MBUF=128M,128M` or `GGML_HEXAGON_DEVICES=2/3` changed nothing.
- What ran on the same PC (first bench): Qwen3.5-4B, Qwen3-4B-Instruct-2507, Qwen3-8B (4,8 GB), Qwen3.5-9B (5,4 GB), Ministral-3-8B-Reasoning, Ministral-8B-Instruct-2410, GLM-4-9B-0414, MiMo-V2.6-Distill-Qwen-9B, Gemma-4-E2B-it, Gemma-3-4B-it, Gemma-3-1B-it, Qwen2.5-Coder-1.5B/3B, Qwen2.5-1.5B, LFM2 and LFM2.5 (1.2B to 8B-A1B), Nemotron-3-Nano-4B, Arch-Function-3B, xLAM-2-3B-fc-r, EXAONE-4.0-1.2B, DeepScaleR-1.5B, VibeThinker-3B, Qwen3-1.7B as a native NPU bundle.
- What did not load: Llama-3.x and derivatives (Llama-3.1-8B, Llama-3.2-3B, Hermes-3, Dolphin3, Groq-Tool-Use, xLAM-8B), Gemma-2-9B (and SPPO), Gemma-4-E4B, MedGemma-4B and TranslateGemma-4B (gemma3 architecture like Gemma-3-4B which ran), Phi-4-mini, Granite-4.x, OLMo-3, Hunyuan 4B/7B/MT-7B, InternLM3-8B, MiniCPM4.1-8B and 5-2B, Aya-Expanse-8B, Apertus, EuroLLM, Salamandra, Falcon3/H1R, EXAONE-Deep-7.8B, SmolLM3, Nemotron-Nano-9B-v2, Nemotron-3.5-Bolt, Seed-Coder, Yi-Coder, OpenCoder, Qwen2.5-7B-Instruct, Jan-v1-4B/Jan-nano/Jan-code-4B (Qwen3 base), Qwen3-4B and Qwen3-1.7B as "custom" GGUF (bartowski), Ministral-3-8B-Instruct and 3B.
- Qwen3-4B-Thinking-2507 and Qwen3.5-4B **had run** on this same PC a few days ago and now fail.

## Questions A (cause and fix)

1. What exactly does the `0x00000200` error from `fastrpc_mmap` mean on the Hexagon v73 NPU of a Snapdragon X1 under Windows, and where in the code (ggml-hexagon, FastRPC driver, QNN/HTP) is it produced? What is the **real limit** of the address space of an HTP session on X1 (3 GB? 3,5 GB? 4 GB?), and what counts towards it (weights, KV cache, compute buffer, 1 GiB alignments)?
2. How can a 5,4 GB model (Qwen3.5-9B) load on a single session while a 2,3 GB model fails? Are the weights mapped dynamically beyond a threshold? Is there a threshold of size, window, `n_ubatch` or number of chunks that flips the behaviour?
3. Which GenieX 0.9.x parameters (flags of `geniex serve` / `geniex infer`, environment variables `GGML_HEXAGON_*` and `GENIEX_*`, configuration file, `device_map` API) control: `n_ubatch`, `n_batch`, the buffer size (`MBUF`), the number of sessions (`DEVICES`), the placement of the embedding/output tensor (`-ot token_embd.weight=CPU` or equivalent), the KV cache type (`-ctk q8_0`)? Which ones are actually read by version 0.9.3 under Windows? Give the exact commands.
4. Search **all** reports of this error (GitHub qualcomm/GenieX, ggml-org/llama.cpp, qualcomm-ai-hub, Qualcomm Developer Forums, Reddit r/LocalLLaMA, r/WindowsOnARM, r/Snapdragon, Hacker News, X) and say what **actually** worked for each one. Look in particular for GenieX #1494, #1507, #1531, #1530, #1503, #1713 and the GenieX versions after 0.9.3 that fix the FastRPC mapping.
5. Can a model have run and then fail without the file changing? Which changes (GenieX version, Windows Insider build, NPU driver, fragmentation after a failure, FastRPC driver state) explain it, and how can the NPU be reset under Windows without rebooting?
6. Hybrid mode (`--compute hybrid`) places part of the tensors on the CPU. Which exact share of the model stays on the NPU, and for which models is it still useful? I keep it as an **option** for the user, not as a default solution.

## Questions B (candidates with a chance of running on the NPU alone)

7. What do the models that load (list above) share that the others do not have? Examine their GGUF files concretely (`gguf-dump`, Hugging Face metadata): vocabulary size, `output.weight` separate or tied to `token_embd.weight`, quantization type of each tensor (pure Q4_0 or mixed with Q6_K/Q8_0/F16), number and size of the largest tensors, number of layers, KV heads, sliding-window attention (SWA), hybrid/SSM layers, MoE, tokenizer type. Give a **table** model by model and say which property best predicts success.
8. Why does Gemma-3-4B-it load and not MedGemma-4B / TranslateGemma-4B (same architecture, same size)? Why does Qwen3-4B-Instruct-2507 load and not the Qwen3-4B/Jan of the same base? Compare the GGUF files from different providers (official Qwen, unsloth, bartowski, ggml-org, QuantFactory, mradermacher, lmstudio-community, second-state, Mungert…) for the same model.
9. Which architectures are **officially** supported on the Hexagon backend of llama.cpp / GenieX (and which ones only have operations falling back to the CPU)? Cite the sources (README, release notes, issues).
10. **Propose candidate models** (up to about 9B, Q4_0 file of 5,5 GB maximum, then 14B if a spread over several sessions works) that have a **real chance** of loading on the NPU alone: for each one, exact name, Hugging Face repository of the Q4_0 GGUF (check that the file exists), most reliable provider, size, parameters (total and active if MoE), architecture, vocabulary size, output tensor type, **precise reason** why it resembles the models that load, and what it brings (code, French, reasoning, tool calling, vision, writing). Favour recently released models (up to October 2026), variants that do not change the architecture of a known-working model (Qwen3/3.5, Gemma-3, LFM2), and native NPU bundles from Qualcomm AI Hub when they exist.
11. Also indicate the models to **avoid** (unsupported architecture, huge vocabulary, giant tensors that cannot be split) and why, so that I do not download them for nothing.

## Answer format

1. A 10-line summary: the most likely cause and the simplest fix, with the confidence level.
2. The answer to each question, with links and dates, distinguishing: *measured/documented by Qualcomm or llama.cpp*, *reported by the community*, *deduction*.
3. The GGUF table (question 7) and the list of candidates (question 10).
4. A **list of experiments to run on my side**, sorted from the simplest to the longest, with the exact commands (for example `geniex infer <model> --log debug`, environment variables, flags), and what each result would mean.
5. The disagreements between sources, and what you could not verify.

Do not stop at the first results: keep going until new searches find nothing new.

## 6. After the research report (Gemini), and what has been confirmed on our side

Result on the user's machine: **a reboot of the PC gets everything working again, and only that.** The NPU therefore stays in a bad state after a failure (the report explains it: the DSP keeps the mappings of the dead process).

**Verified by us (arithmetic on our logs):** the rejected buffer is exactly `n_ubatch x vocabulary size x 4 bytes + 4096`, with `n_ubatch = 1024`: Qwen3 (151 936) = 622 333 952 B, Ministral (131 072) = 536 875 008 B. It is the f32 logits buffer of a micro-batch of 1024 tokens. Gemma-2 (256 000) gives 1 048 576 000 B, the log shows 1 057 542 144 (8,9 MB more, unexplained). With `n_ubatch = 128` this buffer would be 8 times smaller.

**Stated by the report, not verified:** `geniex serve` sets `n_ubatch` to 1024 with no option to change it (GenieX #1557); `GGML_HEXAGON_MBUF` and `GGML_HEXAGON_DEVICES` are not read (the variables read would be `GGML_HEXAGON_NDEV`, `NHVX`, `HOSTBUF`, `VERBOSE`, `PROFILE`, `OPMASK`), which would explain why our attempts changed nothing; an HTP session maps about 3,5 GB; GGUF files with Q6_K/Q4_K/BF16 tensors (bartowski, mradermacher, QuantFactory imatrix) are rejected by the NPU path; the Q4_0 `--pure` GGUF files, those from Google (QAT), LiquidAI and Qwen pass; hybrid mode keeps 85 to 95 % of the weights on the NPU and places the output head on the CPU.

**Applied in the app:**
- **Reset the NPU** button (Settings, Developer): stops geniex and restarts the NPU node with `pnputil /restart-device` (Windows asks for permission). Not tested on a real machine: if the models still fail afterwards, reboot the PC.
- The useless settings (`GGML_HEXAGON_MBUF`, `DEVICES`) are removed from the ladder; `GGML_HEXAGON_HOSTBUF=1` is added to it.
- A setting is kept only if the model answers a real prompt of ~1 500 tokens, and its answer is not noise.

**Still to do / to verify:**
- Find how to lower `n_ubatch` for good (the output of `geniex serve --help`, now copied into the test log, will tell; otherwise call the llama.cpp server directly).
- Check with `gguf-dump` the tensor types of our GGUF files that fail (the report assumes Q6_K without having seen it).
- Check each candidate repository from the report on Hugging Face before adding it to the bench: the report cites repositories and ticket numbers that it could not all open.
- The NPU driver displayed is `10.0.26100.1` (Microsoft generic). Qualcomm drivers carry `30.0.x` versions: the report suggests that a Windows Insider update may have changed it.
