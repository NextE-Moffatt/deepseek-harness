# dsh-kb-core

English | [中文](README.zh.md)

The personal + team knowledge base: Markdown + YAML knowledge cards in the session workspace and in a shared team git repository (`cards/` + document-style `docs/`), with FTS5 search, the promotion state machine, dual-gate governance with freshness scheduling, a heat telemetry projection, the `kb_write` / `kb_read` / `kb_search` / `kb_promote` / `kb_gate_check` / `kb_team_promote` / `kb_team_read` / `kb_review` / `kb_archive` / `kb_revive` / `kb_team_status` / `kb_team_commit` / `kb_freshness` tools, and knowledge-pack injection at session start. Design: [dsh-kb package group and milestone 1 scope](../../../.agents/notes/implemented/feature/2026-08-18-dsh-kb-package-group-milestone-1.md), [knowledge packs and kb/injected injection](../../../.agents/notes/implemented/feature/2026-08-18-dsh-kb-inject.md), and [milestone 3: team library, governance, and telemetry](../../../.agents/notes/implemented/feature/2026-08-19-dsh-kb-milestone-3.md).

## Service

`ctx.kb` (class `KbService`, default export) owns the library seam:

| Method | Behavior |
|---|---|
| `writeCard(root, input)` | Write a new personal-library draft card; generates `{type}-YYYYMMDD-{seq}` ids when omitted and defaults 有效期 to `now + cardTtlDays`. |
| `readCard(root, id)` | Read one card across all tiers; throws when no tier holds the id. |
| `search(root, request)` | FTS5 BM25 retrieval with structured filters, or an explicit `mode: 'scan'` degradation when the index cannot open. |
| `promote(root, id, target, evidence?)` | Assert the state machine, rewrite the card file, and return the new state. |
| `promoteToTeam(root, id, evidence)` | The first gate's admission: enforce the gate rule, move the personal draft into the team library as `pending`, and remove the personal file. |
| `reviewTeam(root, id, approved)` | The second gate: an approved review transitions team `pending` → `ready`; a rejected review changes nothing. |
| `archiveTeam(root, id)` / `reviveTeam(root, id)` | The retire/restore edges: `ready|revived → archived` and `archived → revived`. |
| `teamRead(root, id)` | Read one team card; throws when the team library does not hold it. |
| `teamStatus(root)` / `teamCommit(root, message)` | The team work tree's porcelain status and the stage + commit operation (the human review point). |
| `listTeamDocs(root)` / `readTeamDoc(root, docPath)` | The `docs/` wiki layer, repository-relative; docs never enter the citation pool. |
| `heat(root)` | The aggregated heat ledger: which cards were consumed by which sessions. |
| `freshnessReview(root, today?)` | The pending-review list: overdue and expiring-soon cards with heat and recommendations. |
| `importDir(options)` | Incremental ingest: import card-shaped `*.md` files from a source directory with a checkpoint and dedup. |

The service methods stay session-free; the tools append the `kb/*` session events. Future modules (recap, the web workbench) drive the same seam.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `cardsPath` | `kb/cards` | Library path relative to the session workspace root; tiers P0–P3 are subdirectories, card files are `<id>.md`. |
| `indexPath` | `kb/.kb-index.sqlite` | FTS5 index database path relative to the session workspace root. |
| `cardTtlDays` | `90` | Days added to today when a card's 有效期 is omitted. |
| `teamRepoPath` | — | Team library git work tree (absolute, or relative to the session workspace root); absent disables the team library. |
| `heatPath` | `kb/.kb-heat.jsonl` | Heat ledger path relative to the session workspace root. |
| `freshnessWarningDays` | `14` | Days ahead of 有效期 that count as "expiring soon". |
| `freshnessIntervalDays` | `0` | Days between scheduled freshness scans; `0` disables the scheduler. The scheduler is a per-session `ctx.jobs` job and requires a jobs service (mount `@deepseek-ai/dsh-jobs-local` plus a job controller such as `@deepseek-ai/dsh-tool-jobs`); a configured interval without one logs a loud error per context. |
| `teamWriteApproval` | `true` | Route the team write tools through the approval `ask` gate; without an approval service the gate denies. |
| `packs` | `[]` | Knowledge packs injected at session start; see [Knowledge packs](#knowledge-packs). |

Invalid values fail loud at load.

## Card spec

Cards follow the shared template (design §4.2): YAML front matter with `id` / `type` (`rule` | `case` | `howto` | `decision`) / `title` / 库 / 状态 / 适用条件 / 来源 / 责任人 / 有效期 / 标签, plus body sections 核心结论 / 应做 / 不应做 / 反例 / 踩坑记录. The Chinese keys are the fixed user-facing format and mirror verbatim as TypeScript property names. Parsing fails loud on unknown keys, missing required fields, malformed dates, and unknown enum values; 应做 / 不应做 sections may be empty for imported cards, but `kb_write` requires at least one item each.

## Lifecycle

The promotion state machine is `draft → pending → ready → archived → revived` with `revived → archived`; `kb_promote` exposes only the promotion subset (targets `pending` and `ready`). `revived` is a restored-active state, distinct from never-archived `ready`.

## Events

`kb/write` (a card file written by a tool), `kb/promote` (a lifecycle transition), `kb/team-join` (a personal card entered the team library through the first gate), and `kb/injected` (one knowledge-pack injection) extend `SessionEventMap`; all are appended after the underlying operation succeeds, so the model-visible surface is replayable from the session log.

## Knowledge packs

A knowledge pack is a subscribed card collection injected into every agent session at `agent/session-start`, configured under `KbConfig.packs` as `{ name, tags?, tier?, library?, status?, limit? }` (validated at load: unique non-empty names, closed-enum members, positive integer limits). At session start the listener reads the personal library and, when a team repository is configured, the team library synchronously; selects each pack's cards (every listed tag must be present, tier allowlist applies to personal entries only, library/status allowlists, `archived` excluded by default, id-ascending, capped at `limit`), and appends one `kb/injected` event per pack carrying the rendered card sections. The `kb:pack` prompt section folds those events for every request, so the injected content reaches the first model request with no retrieval step and replays byte-identically from the log alone. Injection is once per session per pack (the log fold is the guard); sessions without a workspace skip injection, packs matching no cards append nothing, and per-pack failures log and continue. The payload's `cardIds` face is the telemetry projection's per-card heat record.

## Extension points

- **Search backend**: `CardIndex` (FTS5 `unicode61`, BM25, per-root database) is swappable; the degradation contract (`mode: 'scan'` with a note, never fabricated results) is part of the interface. CJK runs are char-split so substring queries match without a segmentation dictionary.
- **Ingest seam**: `importDir` is the production-mode-E minimal implementation; `ctx.jobs` scheduling and raw-note wrapping arrive with a real connector.
- **Pack selection**: `selectPackCards` (pure) is the subscription filter over both libraries; a future `kb_pack` tool or the web workbench can wrap it when a real consumer exists.
- **Governance logic**: `evaluateGate`, `gradeCard`, `partitionReview`, and `recommendFreshness` (pure) are the dual gate, quality grade, freshness partition, and heat-based recommendations; the tools and the scheduler compose them.
- **Heat projection**: `projectInjectedHeat` + `HeatLedger` project consumption from `kb/injected` events into the JSONL ledger; rebuildable from session logs alone.

## Model Experience

### Tool schemas

#### What the model sees

The model sees the generated schemas in the [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-kb-core): `kb_write` (tier / type / title / 适用条件 / 核心结论 / 应做 / 不应做 / 来源 / 责任人 / 有效期 / 标签 / 反例, optional `id`), `kb_read` (`id`), `kb_search` (`query` plus optional `type` / `status` / `tier` / `tags` / `limit`), `kb_promote` (`id`, `target: pending|ready`, optional `evidence`), `kb_gate_check` (`id`, `evidence`), `kb_team_promote` (`id`, `evidence`), `kb_team_read` (`id`), `kb_review` (`id`, `approved`, optional `note`), `kb_archive` / `kb_revive` (`id`), `kb_team_status` (none), `kb_team_commit` (`message`), and `kb_freshness` (none). The `kb_write` description embeds the configured `cardTtlDays`.

#### Token effect

Fixed schema cost on every request where the tools are visible.

#### KV Cache effect

Prefix-stable while the definitions and visibility are unchanged; plugin lifecycle may invalidate reuse from these schemas.

### Tool-call results and session events

#### What the model sees

`kb_write` returns `{ id, title, type, tier, status: draft, path }` and logs a `kb/write` event; `kb_read` returns the full card plus tier and path; `kb_search` returns `{ mode: 'fts' | 'scan', total, note?, hits }` where hits are real card files and a scan-mode note explains the degradation; `kb_promote` returns `{ id, from, to, title, path }` and logs a `kb/promote` event (refusing team-library cards with guidance to `kb_review`); `kb_gate_check` returns `{ verdict: PASS|BLOCK, reasons, evidenceCount }`; `kb_team_promote` returns `{ id, title, status: pending, path }` and logs `kb/promote` + `kb/team-join`; `kb_review` returns `{ id, title, status, changed, note? }` and logs `kb/promote` on approval; `kb_archive` / `kb_revive` return `{ id, from, to, title, path }` and log `kb/promote`; `kb_team_status` returns `{ clean, files }`; `kb_team_commit` returns `{ message, output }`; `kb_freshness` returns `{ scanDate, total, overdue, expiringSoon }` review entries. Stable failures: `Error: card not found: <id>`, `Error: invalid card transition <from> → <to> (...)`, gate BLOCK reasons prefixed `kb_gate_check BLOCK:`.

#### Token effect

Result size scales with the returned hits or card fields; call arguments remain until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Knowledge-pack injection

#### What the model sees

Every request carries the `kb:pack` system-prompt section when packs are configured: one `## 知识包：<name>` block per injected pack, each card a `### <id>` heading followed by its rendered knowledge fields (标题 / 适用条件 / 核心结论 / 应做 / 不应做 / optional 反例). Governance metadata (库 / 状态 / 责任人 / 有效期 / 标签) is not rendered.

#### Token effect

The section cost is the sum of the injected card renders, constant across the session once injected (once per session per pack).

#### KV Cache effect

Prefix-stable while the injected packs are unchanged; the section follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **No team-library search** — `kb_search` covers the personal library; the reference pool is reachable through `kb_team_read` and pack injection, and a unified search over both libraries is the kb-search upgrade path.
- **Docs are read-only for agents** — the `docs/` wiki is human reading material; agent-side doc writing awaits the web workbench.
- **kb never clones, fetches, or pushes** — the team repository's remote sync is the team's own git workflow; kb commits stay local until the team pushes.
- **Heat is per workspace** — the ledger at `KbConfig.heatPath` records this workspace's sessions; cross-workspace aggregation for the team library is workbench work.
- **No distributed lock on team cards** — concurrent transitions of one card can lose an update; git conflict resolution at push time is the boundary (see the [git strategy note](../../../.agents/notes/implemented/feature/2026-08-19-dsh-kb-team-git-strategy.md)).
- **Freshness scheduler needs the jobs service** — scheduling requires a composed `ctx.jobs` implementation and controller; without one the on-demand `kb_freshness` tool still works and the misconfiguration logs loudly.
- **Vector/RAG retrieval is deferred** — FTS5 + structured filters are the milestone-1 contract; the kb-search seam absorbs a vector backend past ~500 team cards (design §4.4).
- **Recap, web workbench, and MCP exposure are deferred** — the roadmap milestones 4+.
- **Search reparses the library per sync** — each `search` re-reads and re-parses every card file; the index write is diffed by mtime/size, but parse cost is linear in library size.
- **Raw-note ingestion is deferred** — `importDir` imports card-shaped files and counts raw files as skipped; wrapping notes into cards is the recap/distill milestone's job, and scheduling through `ctx.jobs` awaits a real connector.
- **Chinese search is character-based** — CJK runs are char-split in the FTS index so substring queries match without a segmentation dictionary; ranking and phrase semantics differ from word-segmented search, and a one-character query matches any card containing that character.
- **No atomic file writes** — card writes and the ingest checkpoint use direct writes; a crash mid-write can leave a partial file that the store reports as a parse failure.
- **Injection reads the library synchronously at session start** — the `agent/session-start` emit does not await listeners and the first prompt assembly follows immediately, so the selection uses the store's sync path; the read is bounded by library size and pack filters.
- **Injection is once per session per pack** — new tasks within one session and library edits after session start are not re-injected; packs carry no runtime scene matching (the configured pack list is the subscription), and workspace-file pack definitions await the web workbench.
