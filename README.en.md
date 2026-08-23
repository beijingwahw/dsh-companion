# DeepSeek Companion (Lite)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-blue)](https://github.com/topics/dsh-plugin)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek-Harness-orange)](https://github.com/deepseek-ai/deepseek-harness)

English | [中文](README.md)

> **Edition note**: this repository is the **Lite edition** with the four core modules A–D (conversation export / handoff summaries / cost optimization / global search).
> For the Developer edition (nine modules A–J, adding trace analysis, prompt workbench, model arena, task orchestration, and security audit), see [beijingwahw/dsh-companion-dev](https://github.com/beijingwahw/dsh-companion-dev).

**The official companion plugin for DeepSeek Harness** — built on the Cordis framework and the Harness Plugin SDK, bringing four capabilities to the DeepSeek Harness platform: smart conversation export, context handoff summaries, API cost optimization, and global conversation search.

- Language: TypeScript (`strict: true`, ESM)
- Runtime: DeepSeek Harness (Cordis ≥ 4.0, everything is a plugin)
- API: direct connection to the official DeepSeek API (`https://api.deepseek.com`)
- Data safety: all user data stays inside the Harness plugin sandbox; API keys are stored AES-256-GCM encrypted

---

## Feature Overview

| Module | Capabilities | Toggle |
|---|---|---|
| **A · Smart conversation export** | Markdown / PDF / JSON / **long PNG** export, **turn-level selection** (role badges + content previews + select all/none, exporting only the checked turns), timestamp switch, privacy redaction (auto-masking of phone numbers / emails / ID numbers / bank cards), **visual batch multi-select** (filtering + select-all + live count), multi-session batch ZIP, live export progress with one-click abort; PDFs containing Chinese are rasterized client-side into **print-free multi-page PDFs** (no `window.print()` dialog freeze) | `enableExport` |
| **B · Context handoff summary** | **Session-selection panel** (current-session badge / filtering / pick any historical session), one-click ≤500-char four-section handoff summary, editable, copy to clipboard, save as template; import a summary as the first `system` message of a new conversation for cross-conversation context inheritance | `enableHandoff` |
| **C · API cost optimization (developer mode)** | Encrypted API-key vault, **official dynamic pricing engine** (hourly scraping of DeepSeek and domestic vendor pricing pages; new models / price changes auto-imported; silent fallback to the built-in snapshot on failure), **peak/off-peak time-based pricing**, peak-aware scheduling (peak windows resolved live from the pricing pages), smart model routing, **daily/monthly dual-tier budgets** with 80%/100% alerts and auto-pause of non-essential calls, cache-hit discounted billing, daily/weekly token and cost reports | `enableCost` |
| **D · Global conversation search + in-conversation search** | Fuzzy keyword search, time-range filtering, custom tags (add/remove/filter), click-through to conversations; **in-conversation search** (Ctrl+F floating find bar, non-invasive highlighting via the CSS Custom Highlight API, case/whole-word toggles, query history, auto-resync during streaming output) | `enableSearch` |

All four modules are independent Cordis sub-plugins — enable or disable any combination without side effects.

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
dsh plugin add . --profile web
```

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
- **Edit and reuse**: the summary appears in an editable dialog supporting "Copy to clipboard" and "Save as template"; templates can be viewed and deleted later, and an existing template can be used as the instruction text when generating (falling back to the fixed contract prompt by default).
- **Import for inheritance**: in a new conversation, paste a summary via the "Import history summary" entry in the input dock (or the `handoff-import` command). The plugin arms it for the next new conversation, injecting it automatically as the first `system` message — cross-conversation context inheritance.

### Module C: cost optimization

- **Official dynamic pricing**: the pricing engine scrapes the official DeepSeek pricing page (including the peak/off-peak schedule) hourly, plus pages of domestic vendors (Zhipu / Baidu ERNIE / ByteDance Doubao / Kimi and more), auto-discovering priced models; persisted on change and reused after restart; scraping failures silently fall back to the built-in catalog snapshot without interrupting live pricing. Users can override unit prices per model id (longest-prefix match).
- **Peak/off-peak time-based pricing**: peak windows declared on the pricing page (defaults 9:00–12:00 and 14:00–18:00 Beijing time) bill at peak rates, off-peak at off-peak rates; cache-hit inputs bill at the discounted rate.
- **Peak-aware scheduling**: when enabled, tasks can be marked "urgent / normal". "Normal" tasks enter a deferred queue during peak windows (capacity 100) and fire in off-peak hours; peak windows prefer the pricing engine's live resolution of the pricing page, falling back to built-in defaults on error; queued tasks are re-checked against the budget before executing while paused; interactive operations (like generating a handoff summary) count as "urgent" and never defer.
- **Smart model routing**: when enabled, the model is picked by task type — simple tasks (translation, summarization) go to `deepseek-chat`, complex ones (code generation, reasoning) to `deepseek-coder`; custom routing rules can override the default policy.
- **Daily/monthly dual-tier budgets**: set daily and monthly caps independently (CNY, 0 = unlimited). At 80% of either tier the Harness notification system warns; at 100% it warns again and auto-pauses non-essential API calls (essential calls still pass with continuous alerts).
- **Cost report**: a dedicated view with a detailed visualization panel — summary cards (calls / total tokens / cost / savings / deferred calls / **cache-hit rate** / **daily average cost** / **peak day**), daily/monthly budget progress bars (yellow at 80%, red at 100%) with **in-flight reservation** display, a daily token chart (input/output stacked), a **daily cost-vs-savings chart**, a **model cost ranking** (horizontal share bars with call counts and cost share), a **cache-hit structure bar** (discounted hits vs full-price misses), a **24-hour peak/off-peak timeline** (peak hours highlighted), and a **multi-vendor pricing overview** (vendor + model count + live/snapshot/custom source badges), plus pricing source, fetch time, and manual pricing refresh. The `usage` command prints a quick monthly text report inside the panel.

### Module D: global search and in-conversation search

- A global search box is injected atop the history list (or the `search` command):
  - **Keywords**: fuzzy match across all historical conversations;
  - **Time**: date pickers filter by range;
  - **Tags**: the `tag` command or the results page manages custom tags per session, filterable by tag.
- Results render as a list with hit snippets; clicking jumps straight to the conversation.
- **In-conversation search** (absorbed from dsh-conv-search): click "In-conversation search" in the header or press `Ctrl/Cmd+F` to open the floating find bar:
  - `Enter` / `Shift+Enter`, `F3` / `Ctrl+G`: next / previous hit (wrapping); `Esc` closes; `↑` / `↓` browses query history;
  - `Aa` / `ab` toggles: case-sensitive / whole-word matching;
  - Highlights draw through the CSS Custom Highlight API as an overlay, never touching the React-managed transcript DOM; during streaming output or loading of earlier messages a MutationObserver resyncs automatically, with the active hit kept by "text node + offset" identity so the reader's scroll never jumps;
  - Matching scans only the conversation scrollport, excluding input drafts and the find bar itself — no phantom hits.

---

## Configuration Reference

Root config (any field can be overridden via `cordis.patch.yml`):

| Field | Type | Default | Description |
|---|---|---|---|
| `enableExport` | boolean | `true` | Enable module A |
| `enableHandoff` | boolean | `true` | Enable module B |
| `enableCost` | boolean | `true` | Enable module C |
| `enableSearch` | boolean | `true` | Enable module D |
| `apiBaseUrl` | string | `https://api.deepseek.com` | DeepSeek API base URL (allowed by the manifest) |
| `apiTimeoutMs` | number | `60000` | Per-call API timeout (ms) |

To disable a single module: set its toggle to `false` (config layer) or turn it off in the module declarations of `manifest.json`. Modules are zero-coupled — disabling one never affects the rest.

---

## Architecture at a Glance

```
src/
├── index.ts              # Host entry: mounts the core service + four module sub-plugins per config
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
│   ├── time.ts           #   Beijing-time peak/off-peak window math
│   ├── transcript.ts     #   Conversation transcript formatting (MD/JSON)
│   ├── privacy.ts        #   Privacy redaction (phone/email/ID/bank card)
│   ├── pdf.ts / zip.ts   #   Zero-dependency PDF generation / ZIP packing
│   └── http.ts           #   Private HTTP router (prefix /companion)
├── modules/
│   ├── export/           # Module A: export + batch ZIP + raster payloads (PNG / print-free PDF)
│   ├── handoff/          # Module B: summary generation / templates / armed import
│   ├── cost/             # Module C: gateway / scheduler / routing / dual-tier budgets / settings
│   └── search/           # Module D: search + tags
├── client/               # Browser UI (slot-injected, official component library)
│   ├── index.tsx         #   Client entry: slot registration + in-conversation search lifecycle
│   ├── raster.ts         #   Client raster export engine (ported from dsh-conv-export):
│   │                     #   long PNG / print-free multi-page PDF (foreignObject → canvas → JPEG → PDF assembly)
│   ├── convsearch/       #   In-conversation search (ported from dsh-conv-search):
│   │                     #   engine (Highlight API) / controller (floating bar + hotkeys) / styles
│   └── components/       #   Export dialog / summary dialog / import dock / search view / report view
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
- [x] `DESIGN.md`: architecture contract and development conventions
- [x] Independent module toggles: config switches + independent sub-plugins + manifest module declarations, three layers of assurance

---

## Capability Origins

On top of the original four modules, this plugin absorbs and integrates the core capabilities of three sibling repositories:

| Source repo | Absorbed capabilities | Landing spots |
|---|---|---|
| `dsh-usage-ledger` | Official pricing-page dynamic pricing engine (live scraping/parsing/fallback snapshots), peak/off-peak time-based pricing, multi-vendor price catalog and dedicated parsers, cache-hit discounts, daily/monthly dual-tier budgets | `src/core/price/`, `src/modules/cost/` |
| `dsh-conv-export` | Long-PNG raster export, print-free multi-page PDF (foreignObject → canvas → JPEG → zero-dependency PDF assembly), image data-URL inlining, turn-level selection export (turn preview listing + checkbox panel + progress/abort interaction) | `src/client/raster.ts`, `src/modules/export/` (kind:'raster' payloads, `GET /export/turns` + `turns` request field), `src/client/components/ExportDialog.tsx` |
| `dsh-conv-search` | In-conversation search engine (non-invasive CSS Custom Highlight API highlighting), floating find bar (hotkeys/query history/case and whole-word toggles), MutationObserver resync during streaming and hit-anchor preservation | `src/client/convsearch/` |

During porting we unified the namespace (`companion-*`), comment language, and error-handling discipline, and rewired everything onto this plugin's slots/dual-channel architecture; all changes pass `tsc --noEmit` strict type checking and 39 smoke assertions.

## License

MIT
