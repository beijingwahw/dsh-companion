# DeepSeek Companion (Lite)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-blue)](https://github.com/topics/dsh-plugin)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek-Harness-orange)](https://github.com/deepseek-ai/deepseek-harness)

English | [中文](README.md)

> **Edition note**: this repository is the **Lite edition** with the seven modules A–G (conversation export / handoff summaries / cost optimization / global search / local semantic retrieval / conversation knowledge assets / cross-session knowledge synthesis).
> For the Developer edition (nine modules A–J, adding trace analysis, prompt workbench, model arena, task orchestration, and security audit), see [beijingwahw/dsh-companion-dev](https://github.com/beijingwahw/dsh-companion-dev).

**The official companion plugin for DeepSeek Harness** — built on the Cordis framework and the Harness Plugin SDK, bringing seven capabilities to the DeepSeek Harness platform: smart conversation export, context handoff summaries (hierarchical compression + lineage graph + context-pressure monitoring), API cost optimization (dynamic pricing + predictive cost intelligence), global conversation search, local semantic retrieval (hybrid ranking), conversation knowledge assets (entity graph + related sessions + topic trends), and cross-session knowledge synthesis (Deep Research with cited evidence).

- Language: TypeScript (`strict: true`, ESM)
- Runtime: DeepSeek Harness (Cordis ≥ 4.0, everything is a plugin)
- API: direct connection to the official DeepSeek API (`https://api.deepseek.com`)
- Data safety: all user data stays inside the Harness plugin sandbox; API keys are stored AES-256-GCM encrypted

---

## Feature Overview

| Module | Capabilities | Toggle |
|---|---|---|
| **A · Smart conversation export** | Markdown / PDF / JSON / **long PNG** export, **turn-level selection** (role badges + content previews + select all/none, exporting only the checked turns), timestamp switch, privacy redaction (auto-masking of phone numbers / emails / ID numbers / bank cards), **visual batch multi-select** (filtering + select-all + live count), multi-session batch ZIP, live export progress with one-click abort; PDFs containing Chinese are rasterized client-side into **print-free multi-page PDFs** (no `window.print()` dialog freeze) | `enableExport` |
| **B · Context handoff summary (context engineering 2.0)** | **Session-selection panel** (current-session badge / filtering / pick any historical session), one-click ≤500-char four-section handoff summary, **map-reduce hierarchical summarization** (chunked compression for extra-long conversations, breaking the single-pass character budget, with chunk-level cache reuse), **query focus** (enter a topic to retain only related content), **context lineage graph** (tracks summary propagation across sessions: ancestors/descendants + depth), **context-pressure monitoring** (token estimation + exhaustion forecasting + four-level health advice — see at a glance "how much longer can this conversation go"), editable, copy to clipboard, save as template; import a summary as the first `system` message of a new conversation for cross-conversation context inheritance | `enableHandoff` |
| **C · API cost optimization (developer mode + predictive cost intelligence)** | Encrypted API-key vault, **official dynamic pricing engine** (hourly scraping of DeepSeek and domestic vendor pricing pages; new models / price changes auto-imported; silent fallback to the built-in snapshot on failure), **peak/off-peak time-based pricing**, peak-aware scheduling (peak windows resolved live from the pricing pages), smart model routing, **daily/monthly dual-tier budgets** with 80%/100% alerts and auto-pause of non-essential calls, cache-hit discounted billing, daily/weekly token and cost reports; **predictive cost intelligence**: spend forecasting (OLS linear-regression extrapolation + month-end projection), anomaly detection (median + MAD robust z-scores), what-if simulation (call-volume / cache-hit-ratio / model-shift sandboxes), change attribution (per-model cost-change decomposition answering "where did this month's extra spend go") | `enableCost` |
| **D · Global conversation search + in-conversation search** | Fuzzy keyword search, time-range filtering, custom tags (add/remove/filter), click-through to conversations; **in-conversation search** (Ctrl+F floating find bar, non-invasive highlighting via the CSS Custom Highlight API, case/whole-word toggles, query history, auto-resync during streaming output) | `enableSearch` |
| **E · Local semantic retrieval (self-adaptive retrieval system)** | Fully local **hybrid retrieval engine**: BM25 lexical + character-trigram hashed-vector semantic approximation + RRF reciprocal-rank fusion + **recency-aware weighting** — retrieval quality well beyond keyword matching with zero external dependencies; **query intelligence** (spelling correction + co-occurrence expansion that learns term associations from your own corpus, with provenance notes in the response), **quality diagnostics** (relevance strength + dual-channel coverage + actionable advice), **relevance feedback learning** (a click is feedback: query terms join that session's click profile, and future searches gently boost the sessions you actually opened — saturation counting + 90-day half-life + 35% cap as triple drift protection, the more you use it the better it knows you), **MMR diversity re-ranking** (λ=0.7 greedy selection: the top of the list goes from "the best duplicates" to "the best and complementary combination"), **knowledge map** (all sessions clustered into topic clusters via centroid greedy clustering — discover "which problems you've solved repeatedly"; click a cluster label to dive deeper via search), **query suggestions** (input autocomplete: corpus prefix completion + co-occurrence continuation + click-profile weighting — "your corpus tells you what to search for"), **hit explanations** (every hit carries a transparent ledger: lexical hit terms × frequency, semantic shape similarity, recency/feedback boost breakdown + a one-sentence plain-language summary — "why this session" at a glance), **zero-hit rescue** (on search failure the query is automatically relaxed: wide-threshold correction at 0.35 + noise-term removal, then retried — fully traced and revertible), **retrieval blind-spot analysis** (zero-hit queries are logged automatically; token-level aggregation surfaces "repeatedly searched but never covered" topics — score = searches × dwell span × recency, telling you what knowledge to add), **aortic pulse** (proactive insight engine: blind-spot gaps + feedback-learning profile + index health aggregated on demand into insight cards, severity-ordered and capped at 6 — restrained by design), **online learning to rank** (axis 28, FTRL-Proximal: a click is training — skip-above positive/negative pairs + per-coordinate adaptive learning rates + L1/L2 regularization; the learned multiplier gently boosts sessions you are more likely to open (±30% cap, warmup-eased), persisted across restarts); **one-click semantic/keyword mode toggle**, semantic rank badges (lexical/semantic ranks), hit snippets; lazy incremental indexing (updatedAt drift detection + 5s throttling), corpus statistics and postings incrementally maintained (unfiltered queries skip the full-corpus scan — measured 37× speedup); **negative-term exclusion** (`-term` modifier: `docker network -k8s` drops every session containing the negated term — exclusion is a hard constraint, not a down-weight; tokenization matches the index, and the response carries a `negations` provenance field); command palette `find <terms>` / `map [minSize]` / `blindspots` / `pulse` | `enableRetrieval` |
| **F · Conversation knowledge assets** | Upgrades conversations into accumulable knowledge assets: **entity extraction** (fully local rule-based extraction of six entity types — commands / paths / tech proper nouns / code identifiers / Chinese terms / version numbers — zero LLM calls), **auto tag suggestions** (freq × type-weight × IDF scoring, one-click apply, respecting user judgment), **related-session recommendations** (entity overlap + IDF weighting + cosine-style normalization, answering "which other conversations discuss the same thing"), **global entity graph** (click an entity to launch a search — knowledge becomes a retrieval entry point), **topic-trend evolution** (entity momentum: recent-window vs previous-window frequency change rate, rising / falling / stable direction detection + last-8-weeks weekly coverage timeline — see at a glance "what's heating up and what's cooling down"), **cognition engine** (prospective memory / spaced repetition / analogical retrieval / forgetting forecast / rhythm adaptation / cognitive-load scheduling, axes 20–25), **graph-cognition engine** (**knowledge continents**: Louvain community detection over the entity co-occurrence graph — knowledge domains self-organize into continents with backbone entities, axis 26; **star-map navigation**: personalized PageRank surfaces multi-hop implicit associations from query entities, axis 27; **topic drift**: BOCPD Bayesian change-point detection pinpoints "when attention switched from A to B", axis 30; **memory consolidation**: MinHash-LSH near-duplicate clustering — repeated occurrences of the same question fold into reinforcement, turning repetition from pollution into an asset, axis 31; **knowledge archaeology** (axis 32): time-sliced session eras + per-era Louvain — community lineage matching across adjacent eras yields plate events (**birth / continuation / split / merge / dissolve**), replaying the geology of your knowledge map; **echo radar** (axis 33): session-level MinHash recurrence detection — echo clusters + mean recurrence period ("you re-ask docker networking every 12 days") + recent-window echo rate, themes recurring ≥3 times are recommended for handoff-template consolidation; **knowledge dark matter** (axis 34): link prediction on the entity co-occurrence graph — CN / Adamic-Adar / Resource Allocation indices score entity pairs that **never co-occurred yet share strong neighbor structure**, surfacing the connections your history implies but no conversation has ever made) | `enableKnowledge` |
| **G · Cross-session knowledge synthesis (Deep Research)** | A **deep-research engine** over your entire conversation history: **chunk-level retrieval** (sessions chunked by turns, each chunk scored by lexical hit ratio + trigram cosine on a dual channel), **submodular evidence selection** (facility-location objective = chunk relevance + question-aspect coverage, lazy-greedy approximation with a (1−1/e) guarantee — complementary evidence is prioritized while redundant evidence's marginal gain vanishes; no single session monopolizes the evidence), **contract-based synthesis** (answer only from evidence, `[n]` citation markers, explicit "insufficient evidence" verdicts, conclusions first and contradictions surfaced), **knowledge-evolution tracking** (cross-session belief versioning: when the same topic's version number or value changes over time, an evolution event is emitted — semver-aware comparison flags upgrades/downgrades and builds a belief timeline of "what you should believe now" — the old answer wasn't wrong, just stale), one-click jump back to the source session; **research preview** (`POST /synthesis/preview`: a zero-LLM dry run showing the evidence, aspect coverage, and token budget before you spend anything on synthesis); command palette `research <question>` uses the same channel | `enableSynthesis` |

All seven modules are independent Cordis sub-plugins — enable or disable any combination without side effects.

> **Cognitive architecture 3.0 (axes 1–34)**: the plugin evolves along 34 internal "axes" — from **statistics** (BM25 / rule-based entity extraction / exponential moving averages) through **learning** (FTRL-Proximal online ranking / closed-loop spaced-repetition control / SM2 forgetting schedules) to **reasoning** (Louvain community detection / personalized PageRank / submodular evidence selection / BOCPD change-point detection / MinHash-LSH memory consolidation / time-sliced plate tectonics / session-level echo radar / co-occurrence-graph link prediction). All cognitive computation is fully local: zero LLM calls, zero network requests, zero privacy leakage.

---

## Installation

### Prerequisites
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) `>= 0.1.0`
- Node.js `^22.19 || >=24`
- pnpm (`npm install -g pnpm`)

### One-line install

```bash
dsh plugin add beijingwahw/dsh-companion --profile web
```

The plugin panel loads automatically once started:

```bash
dsh web
```

> Handy commands: upgrade `dsh plugin upgrade dsh-companion --profile web`; uninstall `dsh plugin remove dsh-companion --profile web`; install from a local path `dsh plugin add ./dsh-companion --profile web`. More options after the HMR section below.

---

## Development-time hot reload (HMR)

| Layer | Method | Scope |
|---|---|---|
| Runtime config | Edit the dsh user-level `cordis.patch.yml` (`~/.dsh/profiles/<name>/` or `~/.dsh/`); saving applies immediately | dsh natively watches the user layer and transactionally reloads the line (bundle-level defaults are fully listed — copy the whole line to override) |
| Development code | `npm run dev` starts a standalone cordis + HMR process | Saving any file under `src/` or `cordis.yml` → old instance unloads (effects rolled back) → new code mounts, no restart needed |
| Installed artifact | Change code → `pnpm build` → re-run `dsh plugin add beijingwahw/dsh-companion --profile web` → restart dsh | Updates the installed plugin |

What `npm run dev` consists of: the repo-root `cordis.yml` mounts logger / timer / hmr / host stubs / this plugin in order (loading `src/index.ts` directly, with config matching `cordis.patch.yml` key by key);
`dev/host-stubs.ts` provides minimal stubs for the 7 dsh host services (webServer / storageDomain / credentials / sessionQuery / commands / settings / systemPrompt) — the storage domain is in-memory and cached by name, so development data survives hot reloads.

> Note: development HMR requires Node ≥ 24.11 (early 24.x releases such as 24.1.0 have Node-internal interfaces incompatible with cordis-plugin-loader 1.0.2 — the symptom is edits not triggering reloads).

### Build and install from source (contributors / offline)

```bash
git clone https://github.com/beijingwahw/dsh-companion.git
cd dsh-companion
pnpm install
pnpm run build
pnpm test
dsh plugin add . --profile web
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the dev loop and testing conventions, and [CHANGELOG.md](./CHANGELOG.md) for release history.

---

## Usage

### Configure the DeepSeek API key (required by module C)

1. Turn on the "Developer mode" master switch on the plugin settings page.
2. Paste your DeepSeek API key into the "API Key management" input and save.
   - The key is AES-256-GCM encrypted into the `companion` storage domain of the Harness plugin sandbox;
   - The plaintext key never appears in any response, log, or event (`/cost/state` only returns the `apiKeyConfigured` boolean).
3. Optional: click "Test connection" to validate the key (maps to `/cost/test-call`).

### Module A: exporting conversations

- **Single export**: click "Export" in the conversation header actions, or run the `export` command. Pick a format (Markdown / PDF / JSON / long PNG), choose whether to keep timestamps (default on) and whether to redact privacy, then the file downloads via the browser.
- **Turn-level selection** (ported from dsh-conv-export): check turns one by one inside the export dialog — role badges (user blue / assistant green), two-line content previews, and timestamps; select all / select none with a live selected count. Only the checked turns are exported (e.g. dropping failed attempts or off-topic segments); all turns are selected by default. Batch export does not participate in turn selection.
- **Progress and cancellation**: during raster exports the button shows live tile progress ("done/total"); the "Cancel" button becomes "Abort export" with the abort signal threaded through both the API request and the tile-by-tile rasterization; Esc no longer closes the dialog while exporting (the abort button is the only way out).
- **Long PNG**: the whole conversation is rasterized client-side (SVG foreignObject, 2x retina) into one tall image downloaded directly; client-UI only (the command palette has no canvas) and not part of batch ZIP.
- **Batch export**: checking "Batch export" opens a visual multi-select interface — a select-all/select-none toolbar, a live selected count (n/N), real-time filtering by title or session ID (select-all applies to the current filter result and unions with the existing selection), and checked-row highlighting with unchecked-row fading. Confirm to get a ZIP (up to 100 sessions per run, auto-deduplicated; the `export-batch` command still accepts a plain ID list).
- PDF notes: pure Latin-1 content produces a structured PDF directly; content with Chinese or other non-Latin-1 characters is rasterized client-side into a print-free multi-page PDF (A4 pagination, JPEG encoding, zero-dependency PDF assembly), never touching the `window.print()` dialog — that path freezes the whole browser on some platforms (notably Windows Chrome); environments without raster capability (command palette) fall back to a print view for the browser's save-as-PDF.

### Module B: handoff summaries

- **Generate**: click the "Handoff summary" button in the conversation header (or the `handoff` command). The **session-selection panel** at the top of the dialog defaults to the current session (marked with a "current" badge) and generates the summary automatically; you can also filter by title / session ID and pick **any historical session** — selecting one re-generates automatically (switching cancels in-flight requests and resets the editor). The plugin calls the DeepSeek API with a fixed four-section prompt: core conclusions / resolved problems / key background / open to-dos and unresolved questions (≤500 chars).
- **Map-reduce hierarchical summarization** (context engineering 2.0): when an extra-long conversation exceeds the single-pass summary character budget, it is chunked automatically — the map stage extracts key points per chunk (chunk-level cache: unchanged chunks are never re-called), the reduce stage recursively merges them into the final summary; stats show chunk counts and cache hits.
- **Query focus**: enter a focus topic (e.g. "deployment flow", "performance tuning") in the summary dialog and regenerate — the prompt retains content related to the topic and compresses irrelevant detail: the same budget, more relevant context.
- **Context lineage graph**: the bottom of the summary dialog shows the session's lineage — which sessions content flowed in from (ancestor chain) and which sessions the summaries flowed into (descendant chain), each entry with depth and a content excerpt, making cross-session context propagation visible at a glance.
- **Context-pressure monitoring** (`GET /handoff/context-health`): the pressure gauge atop the summary dialog shows the selected session's token usage live — estimated tokens with a usage-percentage bar, an exhaustion forecast of "how many more turns" extrapolated from the recent N turns' average growth, a four-level health grade (healthy / watch / advice / critical) with matching handoff advice; it helps you judge "is it already too late to hand off now".
- **Edit and reuse**: the summary appears in an editable dialog supporting "Copy to clipboard" and "Save as template"; templates can be viewed and deleted later, and an existing template can be used as the instruction text when generating (falling back to the fixed contract prompt by default).
- **Import for inheritance**: in a new conversation, paste a summary via the "Import history summary" entry in the input dock (or the `handoff-import` command). The plugin arms it for the next new conversation, injecting it automatically as the first `system` message — cross-conversation context inheritance.

### Module C: cost optimization

- **Official dynamic pricing**: the pricing engine scrapes the official DeepSeek pricing page (including the peak/off-peak schedule) hourly, plus pages of domestic vendors (Zhipu / Baidu ERNIE / ByteDance Doubao / Kimi and more), auto-discovering priced models; persisted on change and reused after restart; scraping failures silently fall back to the built-in catalog snapshot without interrupting live pricing. Users can override unit prices per model id (longest-prefix match).
- **Peak/off-peak time-based pricing**: peak windows declared on the pricing page (defaults 9:00–12:00 and 14:00–18:00 Beijing time) bill at peak rates, off-peak at off-peak rates; cache-hit inputs bill at the discounted rate.
- **Peak-aware scheduling**: when enabled, tasks can be marked "urgent / normal". "Normal" tasks enter a deferred queue during peak windows (capacity 100) and fire in off-peak hours; peak windows prefer the pricing engine's live resolution of the pricing page, falling back to built-in defaults on error; queued tasks are re-checked against the budget before executing while paused; interactive operations (like generating a handoff summary) count as "urgent" and never defer.
- **Smart model routing**: when enabled, the model is picked by task type — simple tasks (translation, summarization) go to `deepseek-chat`, complex ones (code generation, reasoning) to `deepseek-coder`; custom routing rules can override the default policy.
- **Daily/monthly dual-tier budgets**: set daily and monthly caps independently (CNY, 0 = unlimited). At 80% of either tier the Harness notification system warns; at 100% it warns again and auto-pauses non-essential API calls (essential calls still pass with continuous alerts).
- **Cost report**: a dedicated view with a detailed visualization panel — summary cards (calls / total tokens / cost / savings / deferred calls / **cache-hit rate** / **daily average cost** / **peak day**), daily/monthly budget progress bars (yellow at 80%, red at 100%) with **in-flight reservation** display, a daily token chart (input/output stacked), a **daily cost-vs-savings chart**, a **model cost ranking** (horizontal share bars with call counts and cost share), a **cache-hit structure bar** (discounted hits vs full-price misses), a **24-hour peak/off-peak timeline** (peak hours highlighted), and a **multi-vendor pricing overview** (vendor + model count + live/snapshot/custom source badges), plus pricing source, fetch time, and manual pricing refresh. The `usage` command prints a quick monthly text report inside the panel.
- **Predictive cost intelligence** (HTTP APIs, consumed by the report view and external integrations):
  - `GET /cost/forecast`: spend forecasting — OLS linear regression fits the "daily cost ~ time" trend and extrapolates the next N days, returning the trend slope, goodness-of-fit R², daily average, per-day forecast points, and a **month-end cost projection** (already spent + forecast to month end); with fewer than 5 days of history it returns `sufficient: false`.
  - `GET /cost/anomalies`: anomaly detection — median + MAD (median absolute deviation) robust z-scores locate cost-anomalous days, immune to outliers (mean/stddev get polluted by the anomalies themselves); severity-graded (mild / high / critical) with expected values and deviation multiples.
  - `POST /cost/what-if`: scenario sandbox — overlay any combination of three operators (call-volume factor, target cache-hit ratio, model shift from → to ratio) on the historical baseline, returning baseline vs projected daily costs, a 30-day projection, and a per-model breakdown.
  - `GET /cost/attribution`: change attribution — compares the last N days against the previous N-day window of equal length, decomposing the cost change into per-model contribution shares (descending), answering "where did this month's extra spend go".

### Module D: global search and in-conversation search

- A global search box is injected atop the history list (or the `search` command):
  - **Keywords**: fuzzy match across all historical conversations;
  - **Time**: date pickers filter by range, or natural language via `range` (`last 7 days` / `上周` / `本月` — unrecognized phrases fall back silently);
  - **Tags**: the `tag` command or the results page manages custom tags per session, filterable by tag.
- Results render as a list with hit snippets; clicking jumps straight to the conversation.
- **In-conversation search** (absorbed from dsh-conv-search): click "In-conversation search" in the header or press `Ctrl/Cmd+F` to open the floating find bar:
  - `Enter` / `Shift+Enter`, `F3` / `Ctrl+G`: next / previous hit (wrapping); `Esc` closes; `↑` / `↓` browses query history;
  - `Aa` / `ab` toggles: case-sensitive / whole-word matching;
  - Highlights draw through the CSS Custom Highlight API as an overlay, never touching the React-managed transcript DOM; during streaming output or loading of earlier messages a MutationObserver resyncs automatically, with the active hit kept by "text node + offset" identity so the reader's scroll never jumps;
  - Matching scans only the conversation scrollport, excluding input drafts and the find bar itself — no phantom hits.

### Module E: local semantic retrieval (retrieval intelligence)

- The mode Pill atop the search view toggles between **semantic retrieval** (hybrid ranking) and **keyword retrieval** (FTS) with one click.
- **Hybrid ranking**: every hit carries lexical-rank and semantic-rank badges plus the RRF fusion score — BM25 captures exact lexical matches, character-trigram hashed vectors capture "similar character composition but different wording" near-synonymous expression (mixed Chinese/English, spelling variants), and RRF reciprocal-rank fusion merges both channels, robust to single-channel failure.
- **Query intelligence** (axis 8): the query is automatically expanded in two stages before retrieval — expansion terms are appended, never substituted:
  - **Spelling correction**: when a query term is absent from the corpus vocabulary, its trigram-cosine nearest neighbor in the vocabulary is adopted (≥ 0.55 and the candidate must actually appear ≥ 2 times) — "perfomance" is rescued back to "performance"; correction candidates are guaranteed to hit your own conversations, no generic dictionary guessing;
  - **Co-occurrence expansion**: for query terms actually present in the corpus, the postings list goes straight to the documents containing them, and the strongest co-occurring term (co-document count × IDF) is appended — the engine learns term associations from your own corpus (Chinese questions ↔ English terms, abbreviations ↔ full names) and keeps evolving as conversations accumulate;
  - Expansion provenance is returned with the response (`expansion.notes`); the intelligence bar in the search view renders Pills like "auth←鉴权 (co-occurrence)" — fully explainable behavior.
- **Recency-aware ranking** (axis 9): the fused score gets a multiplicative recency boost `1 + 0.25 × 2^(-age/30d)` — ranking semantics stay intact; equal relevance is gently nudged toward the recent (at most +25% for the newest, relevance still dominates).
- **Quality diagnostics** (axis 10): every search returns a four-level verdict (strong/fair/weak/empty) + relevance strength (top fused score / theoretical max) + dual-channel coverage + discrimination + actionable advice; empty results distinguish "index not built yet" from "query wording problem"; the intelligence bar translates the black-box score into "can you trust this search".
- **Online learning to rank** (axis 28, FTRL-Proximal): a click is training — the session you open is the positive, unclicked sessions ranked above it are skip-above negatives (weighted 0.25), and a logistic model is optimized online with FTRL-Proximal (per-coordinate adaptive learning rates + L1 sparsity + L2 smoothness); features = lexical rank / semantic rank / recency / feedback profile / title match / bias. The learned multiplier `1 + 0.3 × (2p−1) × warmup` gently boosts sessions you are more likely to click (±30% cap; warmup eases in with training volume to prevent small-sample oversteering) — it reorders, never overrides relevance. The model is persisted to the storage domain and survives restarts; `GET /retrieval/status` exposes ranker diagnostics (updates / clicks / warmup / per-feature weights — what the model learned is fully transparent).
- **Zero external dependencies**: all computation is local — no embedding models, no network requests; a privacy red line — nothing is uploaded to any third party.
- **Lazy incremental indexing + incremental corpus statistics**: before each search the session list is reconciled (updatedAt drift detection, 5s throttling), re-reading only changed sessions; termDf/gramDf/average-length/postings are maintained incrementally on put/delete, and unfiltered queries read the cache directly (skipping the full-corpus scan — measured 37× speedup); the index is persisted to the storage domain and survives restarts. `POST /retrieval/reindex` forces a full rebuild.
- The `find <query>` command in the palette goes through the same hybrid retrieval, with query-expansion provenance and a quality summary line appended to the output.

### Module F: conversation knowledge assets

- **Global entity graph**: the knowledge panel at the bottom of the search view shows the top entities by session coverage (six type badges: command / path / tech / code / term / version); clicking any entity launches a search with the entity name — the knowledge graph becomes a retrieval entry point.
- **Per-session insight**: click the "Knowledge" button on a search result row to expand the panel with that session's insight:
  - **Entity list**: sorted by salience (freq × type weight × IDF) descending, with frequency and global coverage count;
  - **Suggested tags**: top entities recommended as tags, **one-click apply** to the session (reusing module D's tag system; suggestions only, never auto-written — user judgment respected);
  - **Related sessions**: related historical conversations recommended from entity overlap (IDF weighting — sharing a rare entity says more about "discussing the same thing" than sharing a common one; cosine-style normalization avoids long-session bias), with shared entities and similarity scores; click to jump straight there.
- **Entity extraction is fully local rule-based**: line-start command verbs, path patterns, tech proper nouns (acronyms / camel case / frequent capitalized words), code identifiers (camelCase / snake_case / backticks / dot chains), Chinese-quoted terms, version numbers — zero LLM calls, zero cost, zero privacy leakage.
- **Topic-trend evolution** (`GET /knowledge/trends`): the top of the knowledge panel shows an entity momentum board — comparing entity frequencies across two equal windows (last N days vs the previous N days), computing momentum (change rate) and classifying direction as **rising / falling / stable**; each row carries a mini weekly bar chart (sessions covering the entity per week over the last 8 weeks), and clicking a trend row launches a search with the entity name; momentum sorting prioritizes |momentum| × log(total freq), so small-sample noise like "3→6 occurrences" doesn't drown out genuine long-term trends.
- **Prospective memory engine** (axis 20, `GET /knowledge/cognition` / `/knowledge/intentions` / `todo` command): things you said you'd do ("I'll try this tomorrow", "optimize next week", "refactor later") are extracted as prospective intentions — temporal markers (tomorrow/day after/weekend/next week/next month; vague markers default to a 7-day horizon) × intent-verb co-occurrence, questions excluded ("how do I fix this?" is a request, not a commitment); once due they surface proactively (the longer overdue, the higher they rank; ≥14 days escalates to a critical insight) — "5 days ago you said you'd try X — did you?" Honoring it or letting it go both beat forgetting.
- **Spaced-repetition consolidation** (axis 21, `POST /knowledge/review/grade` / `review` command): "problem → solution" episodes extracted from conversations become knowledge cards (problem line paired with a solution line within a window), scheduled by a lean SM2 variant (1/3/7/14/30/60-day ladder) — reviews are prompted when due, in retrieval-practice style (recall the solution from the problem first, then flip to check); "remembered" promotes the interval, "forgot" resets to tomorrow; new episodes sink for a night before their first review, fighting the forgetting curve.
- **Analogical retrieval** (axis 22, `GET /knowledge/analogy?q=` / `analogy` command): a problem is abstracted into a **structural shape** (constraint kind × resolution kind: network / performance / version / dependency / concurrency …) and matched across all historical experience at the shape level — similarity = 0.7 × constraint overlap coefficient + 0.3 × resolution overlap coefficient; low topic-term overlap with a high shape score marks a **cross-domain analogy** (same structure, different domain — e.g. docker network isolation ↔ k8s service connectivity: a precedent topic search can never find), badged and surfaced first.
- **Cognition panel**: the "Cognition panel" button in the search view (`CognitionPanel`) integrates all three axes in one screen — due-intention list (overdue badges + upcoming preview), review cards (recall → check → self-grade loop), and the analogy search box; the "Pulse" button also aggregates the cognition pulse (due intentions / reviews / episode assets), unifying cognition and retrieval signals.
- The `insight` command (global graph) or `insight <sessionId>` (per-session insight) works in the palette.

### Module G: cross-session knowledge synthesis (Deep Research)

- **Entry point**: the "Deep research" button next to the search box in the search view (type a question, then click), or the `research <question>` palette command (e.g. `research What conclusions did I previously reach on performance tuning?`).
- **Chunk-level retrieval**: candidate sessions (FTS keyword recall + recent-session fallback, capped at 32) are chunked by turns (1800 chars/chunk, turns never split across chunks); each chunk is scored on a dual channel — lexical hit ratio + trigram cosine (50/50) — reusing module E's proven tokenizer but at chunk granularity: what is retrieved is an "evidence fragment", not a "session".
- **Evidence selection**: chunks are picked in score-descending order with a per-session cap (3 chunks) so no single long session monopolizes the evidence, gathering as much as fits in the total character budget (26000 chars, at most 10 chunks) — diversity and coverage first.
- **Contract-based synthesis**: the synthesis prompt enforces three disciplines — use only information present in the evidence (answering "insufficient evidence" explicitly when lacking), mark every key claim with `[n]` citations, and lead with the direct conclusion then the supporting points, surfacing contradictions; the answer reads like a mini research report with citations.
- **Result display**: below the answer, all evidence sources are listed (session title + date + excerpt) with one-click jump back to the source session; the stats line shows sessions searched / chunks hit / evidence chunks used / synthesis model.
- **HTTP API**: `POST /synthesis/answer` (body: `{ question }`) → `{ answer, model, sources[], stats }`, for external integrations.

---

## Configuration Reference

Root config (any field can be overridden via `cordis.patch.yml`):

| Field | Type | Default | Description |
|---|---|---|---|
| `enableExport` | boolean | `true` | Enable module A |
| `enableHandoff` | boolean | `true` | Enable module B |
| `enableCost` | boolean | `true` | Enable module C |
| `enableSearch` | boolean | `true` | Enable module D |
| `enableRetrieval` | boolean | `true` | Enable module E (local semantic retrieval) |
| `enableKnowledge` | boolean | `true` | Enable module F (conversation knowledge assets) |
| `enableSynthesis` | boolean | `true` | Enable module G (cross-session knowledge synthesis) |
| `apiBaseUrl` | string | `https://api.deepseek.com` | DeepSeek API base URL (allowed by the manifest) |
| `apiTimeoutMs` | number | `60000` | Per-call API timeout (ms) |

To disable a single module: set its toggle to `false` (config layer) or turn it off in the module declarations of `manifest.json`. Modules are zero-coupled — disabling one never affects the rest.

---

## Architecture at a Glance

```
src/
├── index.ts              # Host entry: mounts the core service + seven module sub-plugins per config
├── config.ts             # Root config schema (schemastery-validated)
├── core/                 # Core infrastructure
│   ├── service.ts        #   CompanionCore root service (ctx.companion, owns the pricing engine)
│   ├── vault.ts          #   SecretVault: AES-256-GCM encrypted vault
│   ├── crypto.ts         #   AES-256-GCM primitives (Node crypto)
│   ├── deepseek.ts       #   DeepSeek Chat Completions client
│   ├── usage.ts          #   Usage bookkeeping store (daily granularity, incl. cache-hit tokens)
│   ├── pricing.ts        #   Pricing bridge (official usage → engine usage shape)
│   ├── price/            #   Dynamic pricing engine (ported from dsh-usage-ledger):
│   │                     #   types / catalog (multi-vendor price catalog) / scrapers (pricing-page parsers) / service
│   ├── retrieval/        #   Local hybrid retrieval engine (axes 1/8/9/10):
│   │                     #   tokenize (tokenizer/trigrams) + engine (BM25 + hashed vectors
│   │                     #   + RRF fusion + recency boost + incremental stats/postings + snippets)
│   │                     #   + query (query intelligence: spelling correction + co-occurrence expansion)
│   │                     #   + quality (retrieval quality diagnostics: verdicts + coverage + advice)
│   ├── cognition/        #   Cognition triad (axes 20/21/22): prospective (prospective memory:
│   │                     #   intention extraction + due computation) + episodes (problem→solution
│   │                     #   episode extraction with structural shapes) + spaced (SM2-lite
│   │                     #   spaced-repetition scheduling) + analogy (shape-level cross-domain matching)
│   ├── insights/         #   Pulse engine (axis 18): provider-injected aggregation
│   │                     #   (blindspots/learning/index/intentions/reviews/episodes → insight cards)
│   ├── time.ts           #   Beijing-time peak/off-peak window math
│   ├── transcript.ts     #   Conversation transcript formatting (MD/JSON)
│   ├── privacy.ts        #   Privacy redaction (phone/email/ID/bank card)
│   ├── pdf.ts / zip.ts   #   Zero-dependency PDF generation / ZIP packing
│   └── http.ts           #   Private HTTP router (prefix /companion)
├── modules/
│   ├── export/           # Module A: export + batch ZIP + raster payloads (PNG / print-free PDF)
│   ├── handoff/          # Module B: summary generation / templates / armed import
│   │                     #   + hierarchical (map-reduce hierarchical summaries) + lineage (lineage graph)
│   │                     #   + context-health (context pressure monitoring: token estimation + exhaustion forecast)
│   ├── cost/             # Module C: gateway / scheduler / routing / dual-tier budgets / settings
│   │                     #   + forecast (predictive cost intelligence: forecast/anomalies/what-if/attribution)
│   ├── search/           # Module D: search + tags
│   ├── retrieval/        # Module E: semantic retrieval plugin (hybrid-ranking wiring + incremental index)
│   ├── knowledge/        # Module F: conversation knowledge assets (entities extraction + inverted index wiring)
│   │                     #   + trends (topic-trend evolution: entity momentum + weekly timeline)
│   │                     #   + cognition wiring (intention/episode/review tables + cognition endpoints & commands)
│   └── synthesis/        # Module G: cross-session knowledge synthesis (Deep Research)
│                         #   retrieval (chunk-level retrieval + evidence selection) + synthesis prompt building
├── client/               # Browser UI (slot-injected, official component library)
│   ├── index.tsx         #   Client entry: slot registration + in-conversation search lifecycle
│   ├── raster.ts         #   Client raster export engine (ported from dsh-conv-export):
│   │                     #   long PNG / print-free multi-page PDF (foreignObject → canvas → JPEG → PDF assembly)
│   ├── convsearch/       #   In-conversation search (ported from dsh-conv-search):
│   │                     #   engine (Highlight API) / controller (floating bar + hotkeys) / styles
│   └── components/       #   Export dialog / summary dialog (focus + lineage + pressure gauge) / import dock /
│                         #   search view (semantic toggle + knowledge panel + trend board + cognition panel + deep research) / report view
└── types/                # Harness subsystem adapter type declarations
```

Key design decisions:

- **Everything is a plugin**: the host entry only orchestrates mounting; each feature module is an independent Cordis function plugin — registration is an effect, and Cordis rolls lifecycles back automatically.
- **Single service facade**: modules never import each other; cross-module collaboration goes through `ctx.companion` (core service) or `ctx.companionCost` (cost gateway).
- **Isomorphic dual channels**: command-palette handlers and private HTTP endpoints (`/companion/*`) reuse the same module service functions — no duplicated logic.
- **Non-invasive UI**: all UI is injected via Harness slots (`conversation.session.header.actions`, `conversation.input.dock`, `conversation.view`), components come from the official UI primitives library, colors use semantic tokens only — no floating windows, no global styles.

The complete internal contract (service signatures, HTTP API, command table, slot list) lives in [DESIGN.md](./DESIGN.md).

---

## Security and Privacy

| Requirement | Implementation |
|---|---|
| Data locality | Conversation content, settings, and API keys are written only to the `companion` storage domain of the Harness plugin sandbox — never uploaded to any third-party server |
| API key encryption | AES-256-GCM (12-byte random IV + auth tag), self-describing payload `v1.<iv>.<tag>.<ciphertext>`; key and ciphertext stored separately |
| Network permissions | `manifest.json` allows exactly the official DeepSeek API, all domestic and major international model-vendor endpoints, vendor pricing pages, and common relay/aggregation gateways for the pricing engine's live scraping; storage is limited to `companion`; the service list is itemized |
| No tracking | No telemetry or behavioral-analytics code; `manifest.json` explicitly declares `tracking: false, telemetry: false` |
| No key leakage | The plaintext key never appears in any response, log, or event; export and summary content is generated locally in the browser only |

---

## Deliverables

- [x] Full Harness plugin source (`src/`, TypeScript strict)
- [x] `manifest.json` (permission and privacy declarations), `package.json`, `cordis.patch.yml` (bundle patch layer), `tsconfig.json`
- [x] `README.md` / `README.en.md`: feature intro, install guide, usage
- [x] `DESIGN.md`: architecture contract and development conventions; `CONTRIBUTING.md`: contribution guide; `CHANGELOG.md`: release history
- [x] Tests & CI: single `pnpm test` entry (11 suites / 226 assertions) + GitHub Actions (Node 22/24 matrix)
- [x] Independent module toggles: config switches + independent sub-plugins + manifest module declarations, three layers of assurance

---

## Capability Origins

On top of the original four modules, this plugin absorbs and integrates the core capabilities of three sibling repositories:

| Source repo | Absorbed capabilities | Landing spots |
|---|---|---|
| `dsh-usage-ledger` | Official pricing-page dynamic pricing engine (live scraping/parsing/fallback snapshots), peak/off-peak time-based pricing, multi-vendor price catalog and dedicated parsers, cache-hit discounts, daily/monthly dual-tier budgets | `src/core/price/`, `src/modules/cost/` |
| `dsh-conv-export` | Long-PNG raster export, print-free multi-page PDF (foreignObject → canvas → JPEG → zero-dependency PDF assembly), image data-URL inlining, turn-level selection export (turn preview listing + checkbox panel + progress/abort interaction) | `src/client/raster.ts`, `src/modules/export/` (kind:'raster' payloads, `GET /export/turns` + `turns` request field), `src/client/components/ExportDialog.tsx` |
| `dsh-conv-search` | In-conversation search engine (non-invasive CSS Custom Highlight API highlighting), floating find bar (hotkeys/query history/case and whole-word toggles), MutationObserver resync during streaming and hit-anchor preservation | `src/client/convsearch/` |

Porting unified the namespace (`companion-*`), comment language, and error-handling discipline, and rewired everything to this plugin's slots/dual-channel architecture; all changes pass strict `tsc -p tsconfig.json` type checking and a cumulative 226 smoke assertions (eleven suites: 28 for core primitives — privacy redaction / AES-256-GCM / ZIP / PDF / Beijing-time peak windows / transcript derivation / pricing conversion; 22 for axes 8/9/10 plus engine-consistency checks, 19 for axes 11/12/13, 17 for axes 14/15/16, 20 for axes 17/18/19, 29 for axes 20/21/22, 29 for axes 23/24/25, 25 for axes 26–31, 14 for axes 32/33 — five-way plate-event classification plus echo clusters / recurrence period / echo rate / action tiers, 6 for axis 34 — CN/AA/RA indices, degree discounting, and connected-pair exclusion, and 17 for the seven-module upgrade pass — redaction v2 (IP/keys/JWT), handoff quality scoring, cost advisor, natural-language time ranges, negative-term exclusion, echo pulse signal; plus Louvain modularity on bilingual corpora, multi-hop PPR gravity, FTRL convergence, submodular-coverage monotonicity, BOCPD changepoint localization, and MinHash-LSH transitive closure). `pnpm test` runs every suite in one command; CI (GitHub Actions, Node 22/24 matrix) guards every commit.

## License

MIT
