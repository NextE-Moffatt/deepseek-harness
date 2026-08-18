# dsh-kb-core

English | [中文](README.zh.md)

The milestone-1 knowledge base: a personal library of Markdown + YAML knowledge cards inside the session workspace, with FTS5 search, a promotion state machine, and the `kb_write` / `kb_read` / `kb_search` / `kb_promote` tools. Design: [dsh-kb package group and milestone 1 scope](../../../.agents/notes/implemented/feature/2026-08-18-dsh-kb-package-group-milestone-1.md).

## Service

`ctx.kb` (class `KbService`, default export) owns the library seam:

| Method | Behavior |
|---|---|
| `writeCard(root, input)` | Write a new personal-library draft card; generates `{type}-YYYYMMDD-{seq}` ids when omitted and defaults 有效期 to `now + cardTtlDays`. |
| `readCard(root, id)` | Read one card across all tiers; throws when no tier holds the id. |
| `search(root, request)` | FTS5 BM25 retrieval with structured filters, or an explicit `mode: 'scan'` degradation when the index cannot open. |
| `promote(root, id, target, evidence?)` | Assert the state machine, rewrite the card file, and return the new state. |
| `importDir(options)` | Incremental ingest: import card-shaped `*.md` files from a source directory with a checkpoint and dedup. |

The service methods stay session-free; the tools append the `kb/*` session events. Future modules (governance, recap, injection) drive the same seam.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `cardsPath` | `kb/cards` | Library path relative to the session workspace root; tiers P0–P3 are subdirectories, card files are `<id>.md`. |
| `indexPath` | `kb/.kb-index.sqlite` | FTS5 index database path relative to the session workspace root. |
| `cardTtlDays` | `90` | Days added to today when a card's 有效期 is omitted. |

Invalid values fail loud at load.

## Card spec

Cards follow the shared template (design §4.2): YAML front matter with `id` / `type` (`rule` | `case` | `howto` | `decision`) / `title` / 库 / 状态 / 适用条件 / 来源 / 责任人 / 有效期 / 标签, plus body sections 核心结论 / 应做 / 不应做 / 反例 / 踩坑记录. The Chinese keys are the fixed user-facing format and mirror verbatim as TypeScript property names. Parsing fails loud on unknown keys, missing required fields, malformed dates, and unknown enum values; 应做 / 不应做 sections may be empty for imported cards, but `kb_write` requires at least one item each.

## Lifecycle

The promotion state machine is `draft → pending → ready → archived → revived` with `revived → archived`; `kb_promote` exposes only the promotion subset (targets `pending` and `ready`). `revived` is a restored-active state, distinct from never-archived `ready`.

## Events

`kb/write` (a card file written by a tool) and `kb/promote` (a lifecycle transition) extend `SessionEventMap`; both are appended after the underlying file operation succeeds, so the model-visible surface is replayable from the session log.

## Extension points

- **Search backend**: `CardIndex` (FTS5 `unicode61`, BM25, per-root database) is swappable; the degradation contract (`mode: 'scan'` with a note, never fabricated results) is part of the interface. CJK runs are char-split so substring queries match without a segmentation dictionary.
- **Ingest seam**: `importDir` is the production-mode-E minimal implementation; `ctx.jobs` scheduling and raw-note wrapping arrive with a real connector.

## Model Experience

### Tool schemas

#### What the model sees

The model sees the generated schemas in the [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-kb-core): `kb_write` (tier / type / title / 适用条件 / 核心结论 / 应做 / 不应做 / 来源 / 责任人 / 有效期 / 标签 / 反例, optional `id`), `kb_read` (`id`), `kb_search` (`query` plus optional `type` / `status` / `tier` / `tags` / `limit`), and `kb_promote` (`id`, `target: pending|ready`, optional `evidence`). The `kb_write` description embeds the configured `cardTtlDays`.

#### Token effect

Fixed schema cost on every request where the tools are visible.

#### KV Cache effect

Prefix-stable while the definitions and visibility are unchanged; plugin lifecycle may invalidate reuse from these schemas.

### Tool-call results and session events

#### What the model sees

`kb_write` returns `{ id, title, type, tier, status: draft, path }` and logs a `kb/write` event; `kb_read` returns the full card plus tier and path; `kb_search` returns `{ mode: 'fts' | 'scan', total, note?, hits }` where hits are real card files and a scan-mode note explains the degradation; `kb_promote` returns `{ id, from, to, title, path }` and logs a `kb/promote` event. Stable failures: `Error: card not found: <id>`, `Error: invalid card transition <from> → <to> (...)`.

#### Token effect

Result size scales with the returned hits or card fields; call arguments remain until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Personal library only** — the team library (shared git repo with `cards/` + `docs/`), knowledge packs and injection (`kb/injected`), governance, telemetry, recap, web workbench, and MCP exposure are post-milestone-1 per the roadmap.
- **Search reparses the library per sync** — each `search` re-reads and re-parses every card file; the index write is diffed by mtime/size, but parse cost is linear in library size.
- **Raw-note ingestion is deferred** — `importDir` imports card-shaped files and counts raw files as skipped; wrapping notes into cards is the recap/distill milestone's job, and scheduling through `ctx.jobs` awaits a real connector.
- **Chinese search is character-based** — CJK runs are char-split in the FTS index so substring queries match without a segmentation dictionary; ranking and phrase semantics differ from word-segmented search, and a one-character query matches any card containing that character.
- **No atomic file writes** — card writes and the ingest checkpoint use direct writes; a crash mid-write can leave a partial file that the store reports as a parse failure.
