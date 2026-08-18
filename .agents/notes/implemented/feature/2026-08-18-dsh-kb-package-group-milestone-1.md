# Agent Note: dsh-kb package group and milestone 1 scope

Status: implemented

English | [中文](2026-08-18-dsh-kb-package-group-milestone-1.zh.md)

## Problem

The harness ships no personal knowledge base. The external design documents (knowledge-base design v0.5 and kb architecture v0.3, referenced from the implementation kickoff) fix the product decisions: a personal + team two-library system with one card spec, a promotion pipeline from personal drafts to the team reference pool, FTS5-first retrieval with an explicit degradation contract, and a plugin family mapped onto dsh extension points. Milestone 1 must make the personal library loop real — Inbox → draft card → retrieval — through a dsh plugin bundle, with every state change logged as replayable session events.

## Decision

**One new package group `packages/kb/` with a single workspace package `@deepseek-ai/dsh-kb-core`** at `packages/kb/kb-core/`. The kickoff's "single package first, split later" choice (decision 7.1 of the kickoff doc) keeps module boundaries as source directories (`card/`, `store/`, `lifecycle/`, `search/`, `ingest/`, `tools/`) until modules stabilize; the group is a container-only directory with its own README and an entry in the [packages table](../../../../packages/README.md), and the `@deepseek-ai/dsh-*` path wildcard in `tsconfig.base.json` gains `./packages/kb/*/src`.

**The card spec follows the design §4.2 template verbatim.** A card is Markdown with a YAML front matter carrying `id` (branded `CardId`, format `{type}-YYYYMMDD-{seq}`), `type` (`rule` | `case` | `howto` | `decision`), `title`, and the Chinese keys 库 / 状态 / 适用条件 / 来源 / 责任人 / 有效期 / 标签; the body carries 核心结论, 应做, 不应做, and optional 反例 / 踩坑记录. The Chinese keys are a user-facing data format fixed by the design, so the TypeScript `Card` type mirrors them verbatim as property names (`card.适用条件`). 应做 / 不应做 sections must be present but may be empty at the model level; the `kb_write` tool requires at least one item each, because it is the "author a proper card" path. 来源 is optional for personal drafts. 有效期 defaults to `now + cardTtlDays` when omitted.

**Personal library storage** lives under `<session cwd>/kb/cards/<tier>/<id>.md` with tiers P0–P3 (`cardsPath` config, default `kb/cards`). Parsing fails loud on unknown front-matter keys, missing required fields, malformed dates, and unknown enum values; id collisions fail loud on write. Files that do not parse as cards are ignored by the store's listing (the library is user-editable; the index reports parse failures per file).

**The promotion state machine** is the closed chain `draft → pending → ready → archived → revived`, with `revived → archived` re-archiving a restored card. `revived` is a restored-active state, distinct from never-archived `ready` for governance. `lifecycle.ts` owns the transition table; `kb_promote` exposes only the promotion subset (targets `pending` and `ready`).

**State changes are logged.** `kb/write` and `kb/promote` extend `SessionEventMap` via declaration merging in `src/types.ts`; tools append them after the file operation succeeds. Ingest-created cards are file facts (no model-visible surface), so they append no event; their 来源 records the source path.

**kb-search** is a `CardIndex` over `node:sqlite` (`DatabaseSync`, FTS5 `unicode61` with BM25) plus a regular `cards` table for structured filters (`type` / 状态 / tier / tags). The index lives at `kb/.kb-index.sqlite` (`indexPath` config), is opened per library root and closed on service disposal, and syncs on each search by reparsing the library and diff-rewriting changed cards (parse cost is linear in library size at milestone-1 scale). Query tokens are quoted and AND-joined so malformed FTS5 syntax cannot fail a search; CJK/kana runs are char-split in both the index and the query (each character becomes its own token, and a multi-character query becomes an adjacency phrase), so substring search works without a segmentation dictionary. The degradation contract is explicit: when the index cannot open, search returns deterministic scan-mode results (`mode: 'scan'`) over the same filters with a note — never fabricated answers.

**Tools**: `kb_search`, `kb_read`, `kb_write`, `kb_promote` register on `ctx.tools` from the service constructor. Descriptions are Chinese because the card vocabulary is Chinese. Render intents decided up front: `kb_write` call/result are `generic` with `locations` when the id is known; `kb_read` and `kb_promote` are `generic`; `kb_search` result is the `search` card kind (`shape: 'paths'` over card file paths, `truncated`/`total` from `presentationMeta`).

**Incremental ingest minimal implementation** is the service method `importDir`: a recursive scan of a source directory for card-shaped `*.md` files, a checkpoint file `kb/.ingest-state.json` keyed by source path (mtime+size skip), and dedup by card id (a new import lands as `draft`; re-import preserves the existing card's status). Raw non-card files are skipped and counted. Scheduling through `ctx.jobs` and raw-note wrapping are deferred to the recap/governance milestones.

**The plugin** is a Cordis service (`KbService extends Service`, default export, registered as `ctx.kb`) with `Config` fields `cardsPath`, `indexPath`, `cardTtlDays` (default 90) resolved at load and failing loud on invalid values. The type vocabulary lives on the [kb subsystem page](../../../../docs/subsystems/kb.md) with its generated cordis-surface region; the tool schemas render into the [tool catalog](../../../../docs/tool-catalog.md#deepseek-aidsh-kb-core) and the `kb/*` event payloads into the [persistence catalog](../../../../docs/persistence-catalog.md#kbpromote--log-only). An `./invariant` companion validates `kb/*` payload shapes and transition legality from the session log; it mirrors the closed value sets and transition table locally rather than importing the runtime modules, because a built companion bundle must not depend on shared chunks that the package's declared `files` list does not publish.

**Verification** is unit tests per module plus a Loader composition test that boots a test-only `cordis.yml`, runs the acceptance chain in a real workspace directory (`kb_write` a draft card → `kb_search` finds it → `kb_promote` flips the state → the `kb/*` events replay from the session log), per the repository testing policy.

## Alternatives considered

**Split the family into separate packages now.** Rejected: the module boundaries (search, tools, inject, govern) are not stable enough to freeze as package seams; the kickoff's "single package, split when stable" avoids speculative renames.

**English front-matter keys with a mapping layer.** Rejected: the design §4.2 template is the fixed user-facing spec; a key translation table is a second source of truth that can drift from the template.

**Strictly non-empty 应做 / 不应做 everywhere.** Rejected: imported and hand-edited cards can legitimately lack one side; the authoring tool enforces non-empty where the spec's intent applies.

**Require the model to supply `id` in `kb_write`.** Rejected: sequence generation is a store concern (`{type}-{YYYYMMDD}-{seq}` with the max existing sequence for the prefix); requiring it makes collisions the model's problem.

**Wrap raw notes into draft cards at import.** Rejected: it would fabricate 核心结论 / 应做 content from arbitrary text. The recap/distill milestone owns converting raw notes into cards.

**Periodic `ctx.jobs` ingest watcher in milestone 1.** Rejected: there is no configured data source yet; the service seam ships, scheduling arrives with a real connector.

## Consequences

The single package grows until module boundaries stabilize, and Chinese property names in the card model are unusual for this repo — both are deliberate (kickoff decisions 1 and 7.1). Search reparses all card files per sync; acceptable at milestone-1 scale, documented as a limitation. P0/P1 tiers accept any card shape via `kb_write`; tier-specific semantics (Inbox weekly clearing, project notes) are product work beyond milestone 1. The team library, knowledge packs and injection (`kb/injected`), governance, telemetry, recap, web workbench, and MCP surfaces stay deferred per the roadmap, and the `ctx.kb` seam, `kb/*` events, and `kb-search` interface are the extension points those milestones build on. The acceptance chain — write, retrieve, promote, replay — works in a real workspace with no agent-loop changes.
