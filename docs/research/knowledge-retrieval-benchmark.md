# Document retrieval benchmark

Harness: `tests/knowledgeBench.ts`, run by `tests/knowledge-bench.test.ts` (`MKMN_BENCH_OUT=<file>` writes the report).

## What was measured

The real chat turn (`runChatOrchestrator`) runs 60 cases with a scripted model server:

- 39 frozen eval cases (`tests/fixtures/evals/knowledge.json`) over the fixture corpus: an English handbook PDF (200 pages), an Arabic guide PDF, a scanned PDF, a Word file, a workbook and a deck. The project mixes English and Arabic files.
- 21 report cases over two 60-page interim reports. One is a synthetic report whose quarters carry close figures. The other is the Aramco Q3 2026 report with note 18 on page 43. The cases cover exact names (6), quarters that are easy to confuse (3), paraphrases (4), Arabic questions over English files (4), one two-quarter comparison, the Aramco ownership lookup, and two rechecks after a wrong answer. One recheck follows Aramco's reversed answer.

The scripted model helps every path. The locator names the supporting section whenever its outline holds it, and the rewrite returns the case's own search words. Recall and accuracy are therefore upper bounds for the model-dependent paths. They are not measurements of a 4B model.

| Measure | Definition |
| --- | --- |
| Recall@5 | The supporting section is among the first five sections of the answer request. For a quoted answer, the supporting page must be cited. |
| BM25 top 5 | The supporting section is in BM25's top five for the question's own words, with no rewrite and no locator. |
| Accuracy | A quoted answer must contain every expected value and cite the supporting page. A model answer counts only if the supporting section with every value reached the model. |
| Modeled time | Published rates for a 4B model on this NPU: prefill 786.7 tokens/s, decode 35 tokens/s, 0.14 s per call. Output is 6 tokens for the locator, 12 for the rewrite and 120 for the answer. **An estimate, not a device measurement.** |

## Results (warm pass, 60 cases)

| | Before (`3f41fd2`) | After |
| --- | --- | --- |
| Recall@5 | 98.3 % | 98.3 % |
| Accuracy | 98.3 % | 98.3 % |
| BM25 top 5 (question words only) | 81.7 % | 81.7 % |
| Answered from a source quote | 3.3 % | 23.3 % |
| Turns with a locator call | 96.7 % | 30.0 % |
| Turns with a rewrite call | 76.7 % | 28.3 % |
| Model calls per turn | 3.67 | 2.12 |
| Answer request, p50 tokens | 5,281 | 3,813 |
| Retrieved section text, p50 characters | 1,389 | 228 |
| Host time p50 / p95 (no model) | 4.7 / 6.4 ms | 2.1 / 4.4 ms |
| Modeled first token p50 / p95 | 12.6 / 13.2 s | 8.9 / 13.3 s |
| Modeled turn p50 / p95 | 16.0 / 16.6 s | 12.3 / 16.8 s |

By group, after the change:

- Exact and quarter lookups (9 of 9) are quoted from the right page, with no model call and no wrong-quarter answer.
- The frozen English, Arabic, Word, Excel, PowerPoint and scan cases mostly take the strong path. The locator is called in 25.6 % of these turns instead of 100 %.
- Paraphrases, Arabic questions over English files and the comparison keep the rewrite and the locator, as before.
- The Aramco lookup and both rechecks cite page 43. They keep Aramco's 49 % and PIF's 51 % for both HUMAIN entities.

The p95 is unchanged because the slowest turns are still the cross-language and paraphrase turns, which keep both model calls.

## Index cost (cold and warm)

| Corpus | First build | New process (store read) | Same process, before | Same process, after | One search |
| --- | --- | --- | --- | --- | --- |
| Fixtures (6 files) | 10.8 ms | 4.4 ms | 5.1 ms | 0.3 ms | 0.13 ms |
| Reports (2 files) | 4.1 ms | 2.8 ms | 2.7 ms | 0.2 ms | 0.07 ms |
| Large (100 files, 10 MB) | 464 ms | 448 ms | 409 ms | 8.9 ms | 9.4 ms |

The large corpus's index takes about 61 MB of heap. The in-memory indexes are therefore capped at four projects and 16 million characters. The process's peak resident memory during the whole benchmark was 441 MB before and 380 MB after; that figure includes the test runner. Keyword search stays on the CPU in the sidecar.

## Figures quoted from the source

`figurePassage` quotes a sentence only when the sentence holds every subject word of the question, including the entity and the period, plus a value the question does not already name. Results on the benchmark:

- It answered all nine exact and quarter lookups from the right page, with no wrong-quarter quote. "Net income for Q2 2026" chose page 6's sentence (6.9) over page 5's, which also mentions Q2 but reports Q3's 7.4.
- It found no qualifying sentence for any paraphrase ("earn", "debt", "people work"), so those questions went to the model. A missing word gives a fallback, not a wrong quote.
- Two files with different Q3 revenue were quoted side by side as a disagreement (`tests/knowledge-fast.test.ts`).
- Table rows (`| Q1 2026 | 38.1 |`) are not sentences and are never quoted. A figure that appears only in a table goes to the model.

## Embeddings: not added

With a competent rewrite, BM25 put the supporting section in the top five for 59 of 60 cases. The miss was a hard paraphrase ("money went into investment projects between July and September" for capital expenditure in Q3). Without the rewrite, 11 cases miss: the six frozen cross-language cases, two Arabic-over-English report questions, the Arabic Aramco question and two paraphrases. The cross-language gap is the rewrite's. The device runs recorded the 4B writing English search words for an Arabic file.

A local multilingual embedding model could replace that rewrite for cross-language questions only. That would be a separate experiment and was not run here. It needs a model download and a runtime dependency, which this task did not have approval for. It also needs a device measurement of embedding the corpus on the CPU or the NPU, beside the chat model and the router. The earlier decision (lexical, no embedding model) stands until that experiment shows a cross-language recall gain on the device that the rewrite cannot reach.

**Device evidence** (installed builds, Qwen3-4B on the NPU):

- The rewrite wrote `3000000…` for an Arabic question over English files.
- The locator counted `9,10,11,12,…` or `22, 23, 24,…` instead of naming sections.
- Both cross-language turns cited the wrong file, before and after the output cap.

On this device, the rewrite that the scripted benchmark assumed does not exist. That makes the embedding experiment worth running for questions in another script than the files. It still needs approval for the model download and the runtime dependency.

## Not measured

- Time to first token, locator time and total turn time on the installed app with a real model on the NPU. The new journal timings and the `[knowledge]` log line exist to record them.
- The 4B model's own rewrite and locator quality. The benchmark uses a generous scripted model.

## Multilingual-embedding experiment


**Setup.** It used the same 60 cases and sections as the benchmark above (exported from `tests/knowledgeBench.ts`). Each section was embedded on the CPU and compared with each question by cosine similarity. The runtime was `onnxruntime-node` 1.21 (its `win32-arm64` binary) through `@huggingface/transformers` 3.8.1, installed in a scratch folder, not in the app. The weights were q8 ONNX files from Hugging Face. A section was cut at 1,500 characters, because these models read at most 512 tokens. Recall@5 is scored on the supporting section, as above, with no model involved.

| Model (q8) | Size | Recall@5, all 60 | 10 cross-language cases | 4 paraphrases | Warm load | Embedding 349 sections | Query p50 / p95 | Process peak RSS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BM25 alone (today) | — | 85.0 % | 20 % | 75 % | — | — | — | — |
| multilingual-e5-small | 129 MB | 91.7 % | 50 % | 100 % | 1.4 s | 6.3 s | 4.7 / 10.2 ms | 516 MB |
| **paraphrase-multilingual-MiniLM-L12-v2** | **129 MB** | **98.3 %** | **100 %** | **100 %** | **0.85 s** | **1.65 s** | **2.8 / 5.5 ms** | **521 MB** |
| multilingual-e5-base | 282 MB | 93.3 % | 80 % | 50 % | — | 4.9 s (cold) | 5.8 / 10.8 ms | 719 MB |

Node alone takes 52 MB of RSS, and 73 MB with the runtime loaded. Most of the peak comes from batched inference while the sections are embedded.

**How to combine it with BM25** (MiniLM; the app's own strong gate and `mergeByBestRank`):

| Strategy | Recall@5 |
| --- | --- |
| BM25 | 85.0 % |
| Vectors alone | 98.3 % (its one miss, a spreadsheet row, is a strong BM25 match) |
| Merge by best rank, or reciprocal-rank fusion | 95.0 % (BM25's stray matches on a cross-language question outrank the right section) |
| **Strong BM25 match → BM25; any other question → vectors alone** | **100 %** (vectors on 33 % of turns) |

**What this means for the device.** The 4B's rewrite and locator replies were degenerate on the installed build, so a question in another script than the files has no working path today. MiniLM found every one of those cases in about 3 ms, on the CPU, with no model call. It could replace the rewrite call and, for weak matches, the locator call. That would also remove up to two model calls (2.6 to 4.3 s on the device after the cap) from every non-strong turn.

**Cost and limits.**
- A model download of about 129 MB, and a runtime dependency. `onnxruntime-node` unpacks to about 300 MB for all platforms; the app would ship only the win32-arm64 part.
- Embedding every section when files are added: about 5 ms per section here.
- Roughly 450 MB more memory while embedding. That falls if the batches are smaller.
- The model runs on the CPU, so it competes with the router's CPU GenieX. Moving it to the NPU is not measured.
- 60 cases with a scripted corpus are a small sample. The 100 % shows MiniLM covers these cases; it does not prove it will cover every question.
- The packing problem is separate, and vectors don't fix it. One large page can still fill a 4,778-character budget.

**Built.** The gated vector path is in the app: `src/core/knowledge/embed.ts`, `vectors.ts`, `vectorModel.ts`, and the vector branch of the retrieval step. Through the app's own turn with the real model, the 60 cases reached 100 % recall@5 and 100 % evidence accuracy with no rewrite call (record). Under the device's junk helpers, recall@5 went from 85 % to 100 % and cross-language cases from 2 of 10 to 10 of 10. While building it, a sheet labelled "Equipment" instead of "Equipment rows 1-7" fell out of the top eight. The scores of the nearest sections lie close together (0.35 to 0.39 here), so the embedded text keeps the measured form `file placeOf(section)`.

**Recommendation before the decision.** The earlier decision "lexical, no embedding model" now has a measured counter-case. A gated vector path, with MiniLM on the CPU used only when BM25 is not a strong match, fixed every cross-language and paraphrase miss in this benchmark at 3 ms per query. Building it would replace that decision. It is not built.
