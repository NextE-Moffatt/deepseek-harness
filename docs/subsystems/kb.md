# Knowledge Base

English | [中文](kb.zh.md)

The personal + team knowledge library: `ctx.kb` owns card write/read, the promotion state machine, FTS5 search with the scan degradation contract, incremental ingest, knowledge-pack injection at session start, the team git library (cards/ + docs/), the dual-gate governance with freshness, and the heat telemetry projection, and registers the `kb_write` / `kb_read` / `kb_search` / `kb_promote` / `kb_gate_check` / `kb_team_promote` / `kb_team_read` / `kb_review` / `kb_archive` / `kb_revive` / `kb_team_status` / `kb_team_commit` / `kb_freshness` tools. The [milestone-1 Agent Note](../../.agents/notes/implemented/feature/2026-08-18-dsh-kb-package-group-milestone-1.md) owns the package-group decision, the [injection Agent Note](../../.agents/notes/implemented/feature/2026-08-18-dsh-kb-inject.md) owns the knowledge-pack decision, and the [milestone-3 Agent Note](../../.agents/notes/implemented/feature/2026-08-19-dsh-kb-milestone-3.md) owns the team-library, governance, and telemetry decisions; this page records the exact types from [`packages/kb/kb-core/src/types.ts`](../../packages/kb/kb-core/src/types.ts).

## Card model

A card is Markdown plus YAML front matter, one spec shared by both libraries. The Chinese front-matter keys (库 / 状态 / 适用条件 / 来源 / 责任人 / 有效期 / 标签) are the fixed user-facing format and mirror verbatim as TypeScript property names; the body sections 核心结论 / 应做 / 不应做 / 反例 / 踩坑记录 parse into the remaining fields.

```ts type-equiv
/**
 * A knowledge-card id, unique across one library. The design's id format is
 * `{type}-YYYYMMDD-{seq}` (for example `rule-20250818-001`); the format is
 * enforced by the card parser, not by this brand.
 */
type CardId = Branded<'CardId'>
```

```ts type-equiv
/** The four knowledge-card types of the shared card spec (§4.1). */
type CardType = 'rule' | 'case' | 'howto' | 'decision'
```

```ts type-equiv
/** Which library a card belongs to. Milestone 1 ships `personal`; `team` is the shared git repo (post-milestone-1). */
type CardLibrary = 'personal' | 'team'
```

```ts type-equiv
/**
 * Lifecycle states of the promotion pipeline. `draft` is the personal-library
 * entry state; `pending` awaits verification; `ready` is the reference pool;
 * `archived` is retired; `revived` is a restored-active state, distinct from
 * never-archived `ready` so governance can tell the two apart.
 */
type CardStatus = 'draft' | 'pending' | 'ready' | 'archived' | 'revived'
```

```ts type-equiv
/** Personal-library tiers, encoded as the card's directory: P0 Inbox, P1 project notes, P2 draft cards, P3 private experience. */
type CardTier = 'P0' | 'P1' | 'P2' | 'P3'
```

```ts type-equiv
/**
 * The three governance grades of the quality-grading mechanism (design §6):
 * `verified` is a ready/revived card inside its 有效期; `pending` is a card
 * awaiting verification; `verify` is a card that needs re-verification (a
 * ready/revived card past its 有效期, or a retired one). The grade is derived
 * from the card's status and expiry, never stored on the card.
 */
type CardGrade = 'verified' | 'pending' | 'verify'
```

The promotion state machine is the closed chain `draft → pending → ready → archived → revived` with `revived → archived`; `kb_promote` exposes only the promotion subset (targets `pending` and `ready`), while the govern tools expose the retire/restore edges (`kb_archive`, `kb_revive`) and the second gate (`kb_review`). Card parsing fails loud on unknown keys, missing required fields, malformed dates, and unknown enum values; 应做 / 不应做 sections may be empty for imported cards, while the `kb_write` tool requires at least one item each.

## Team library

The team library is a git work tree at `KbConfig.teamRepoPath` (absolute, or relative to the session workspace root): structured cards under `cards/`, document-style wiki text under `docs/` for humans — docs never enter the card list, the search index, or the citation pool. kb reads and writes the working tree only; commits are the explicit `kb_team_commit` operation (draft → review → commit, with `kb_team_status` showing the pending diff), and the write tools route through the approval `ask` gate when `KbConfig.teamWriteApproval` is set. The git concurrency and approval strategy is decided in the [team git strategy Agent Note](../../.agents/notes/implemented/feature/2026-08-19-dsh-kb-team-git-strategy.md).

## Search contract

`CardIndex` runs FTS5 `unicode61` (BM25) over a per-library-root database at `kb/.kb-index.sqlite` (`indexPath` config), with a regular `cards` table for structured filters (type / 状态 / tier / tags). CJK/kana runs are char-split in both the index and the query, so substring search works without a segmentation dictionary. The degradation contract is explicit: when the index cannot open, `search` returns deterministic scan-mode results (`mode: 'scan'`) over the same filters with a note — never fabricated answers.

## Session events

State changes are logged: `kb/write` records a tool-performed card write, `kb/promote` records a lifecycle transition, `kb/team-join` records a personal card entering the team library through the first gate, and `kb/injected` records one knowledge-pack injection at session start. All are appended after the underlying operation succeeds, so the model-visible surface replays from the session log; `kb/injected` carries the full rendered card sections, so the `kb:pack` prompt section reconstructs from the log alone. The full payload declarations live in the [persistence catalog](../persistence-catalog.md#kbpromote--log-only).

## Knowledge packs

A knowledge pack is a subscribed card collection injected into agent sessions at session start. The deployment's configured pack list is the scenario subscription — each pack carries the filters that select its cards:

```ts type-equiv
/**
 * A knowledge pack: a subscribed card collection injected into agent sessions
 * at session start. The deployment's configured pack list IS the scenario
 * subscription — each pack carries the filters that select its cards.
 */
interface KnowledgePack {
  /** Unique pack name, shown to the model as the pack header. */
  name: string
  /** Filter: every listed tag must be present on the card. */
  tags?: readonly string[]
  /** Filter: tier allowlist (personal-library tiers). */
  tier?: readonly CardTier[]
  /** Filter: library allowlist; when absent, cards from both libraries are eligible. */
  library?: readonly CardLibrary[]
  /** Filter: status allowlist; when absent, `archived` cards are excluded by default. */
  status?: readonly CardStatus[]
  /** Maximum cards injected per session; no cap when absent. */
  limit?: number
}
```

```ts type-equiv
/** One injected card's rendered section, the replayable unit of a pack injection. */
interface PackSection {
  /** The card id, also the rendered heading. */
  name: string
  /** The rendered card content (title / 适用条件 / 核心结论 / 应做 / 不应做 / optional 反例). */
  text: string
}
```

Packs are declared under `KbConfig.packs` and validated at load (unique non-empty names, closed-enum tier/library/status members, positive integer limits, no unknown keys). At `agent/session-start` the injection listener reads the personal library and, when a team repository is configured, the team library synchronously; selects each pack's cards (`tags` must all be present, tier allowlist applies to personal entries only, library/status allowlists, `archived` excluded by default, id-ascending, capped at `limit`), and appends one `kb/injected` event per pack with the rendered sections. The `kb:pack` prompt section folds those events and renders the pack headers and card blocks for every request. Injection is once per session per pack (the log fold is the guard), so resume and fork inherit the injection and replay reproduces the section byte-identically. Sessions without a workspace skip injection, packs matching no cards append nothing, and per-pack failures log and continue.

## Governance

The dual gate (design §5.3) is state-machine-shaped: `kb_gate_check` evaluates the first gate (evidence → PASS/BLOCK over structural facts — personal draft, 来源 link, executable checklist, non-empty evidence), `kb_team_promote` enforces the same rule at the promotion point and moves the card into the team library as `pending` (`kb/team-join`), and `kb_review` is the second gate — human review transitions `pending → ready` into the reference pool. The quality grade is derived per card (`gradeCard`: `verified` / `pending` / `verify`), the freshness scan (`kb_freshness` plus the optional `ctx.jobs` scheduler under `KbConfig.freshnessIntervalDays`) partitions cards into overdue and expiring-soon with heat-based recommendations (renew / review / archive-candidate / revive-candidate), and `kb_archive` / `kb_revive` apply the state machine's retire/restore edges. Freshness defaults and approval behavior are deployment config; the [milestone-3 Agent Note](../../.agents/notes/implemented/feature/2026-08-19-dsh-kb-milestone-3.md) owns the module decisions.

## Telemetry

Consumption heat is projected from the session log, never recorded as a second event stream: every `kb/injected` event contributes one ledger entry per card id to the workspace's JSONL heat ledger (`KbConfig.heatPath`, default `kb/.kb-heat.jsonl`), and the ledger aggregates to per-card rows (count, last session, packs). The projection is rebuildable from session logs alone (`projectInjectedHeat` over any log reproduces the entries). Heat feeds the freshness recommendations and the future revival/promotion signals.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxkb--kbservice"></a>

### `ctx.kb` — `KbService`

`ctx.kb`: owns the personal library seam — card write/read, promotion, search, and incremental ingest — plus the milestone-1 tools and the knowledge-pack injection wiring (session-start trigger + `kb:pack` section).

```ts cordis-catalog
/** The absolute team repository path for one workspace root (config-relative paths resolve against the root).
 * @param root - the session workspace root.
 * @returns the absolute team repository path.
 */
teamRepoRoot(root: string): string

/**
 * Write a new personal-library draft card, generating the id when omitted.
 * @param root - the session workspace root.
 * @param input - the card to write (values validated at the tool boundary).
 * @returns the written card, tier, and absolute path.
 */
async writeCard(root: string, input: WriteCardInput): Promise<CardWriteResult>

/**
 * Read one card by id across all tiers.
 * @param root - the session workspace root.
 * @param id - the card id.
 * @returns the card file info; throws when no tier holds the id.
 */
async readCard(root: string, id: CardId): Promise<CardFileInfo>

/**
 * Search one library: FTS5 BM25 with structured filters when the index is
 * available, otherwise a deterministic full-library scan with an explicit
 * `mode: 'scan'` note. Results are always real card files.
 * @param root - the session workspace root.
 * @param request - the retrieval request.
 * @returns the retrieval outcome with its mode.
 */
async search(root: string, request: SearchRequest): Promise<SearchOutcome>

/**
 * Apply a promotion transition: assert the state machine, rewrite the card
 * file, and return the new state. The caller (tool) appends `kb/promote`.
 * @param root - the session workspace root.
 * @param id - the card id.
 * @param target - the requested next state (promotion subset: `pending` or `ready`).
 * @param evidence - optional objective signal.
 * @returns the card in its new state plus the transition.
 */
async promote(root: string, id: CardId, target: CardStatus, evidence?: string): Promise<PromoteResult>

/**
 * Run the incremental ingest over a source directory into the library at
 * `options.root` (see {@link importDir}).
 * @param options - import options.
 * @returns the import outcome.
 */
importDir(options: ImportOptions): Promise<IngestResult>

/**
 * The first gate's admission: promote a personal draft into the team
 * library as `pending` (库: team). The gate rule from `evaluateGate` is
 * enforced here — a BLOCK verdict throws before anything is written — so
 * the promotion point, not the advisory `kb_gate_check` tool, is the
 * enforcement. The personal file is removed after the team write succeeds.
 * @param root - the session workspace root.
 * @param id - the personal draft card id.
 * @param evidence - the objective signals (上线/交付/关闭/评审/复用).
 * @returns the card in its new library plus the team file path.
 */
async promoteToTeam(root: string, id: CardId, evidence: readonly string[]): Promise<{ card: Card; path: string }>

/**
 * Look up a card in the personal library, returning undefined when no tier
 * holds it.
 * @param root - the session workspace root.
 * @param id - the card id.
 * @returns the card file info, or undefined.
 */
async personalCard(root: string, id: CardId): Promise<CardFileInfo | undefined>

/**
 * Look up a card in the team library, returning undefined when the library
 * does not hold it (or is not configured).
 * @param root - the session workspace root.
 * @param id - the card id.
 * @returns the team card file info, or undefined.
 */
async teamCard(root: string, id: CardId): Promise<TeamCardFileInfo | undefined>

/**
 * Read one team-library card.
 * @param root - the session workspace root.
 * @param id - the card id.
 * @returns the card file info; throws when the team library does not hold it.
 */
async teamRead(root: string, id: CardId): Promise<TeamCardFileInfo>

/**
 * The second gate (human review): an approved review transitions a team
 * `pending` card to `ready` (the reference pool); a rejected review changes
 * nothing and the card stays `pending` for more evidence. The caller (tool)
 * appends `kb/promote` on approval.
 * @param root - the session workspace root.
 * @param id - the team card id.
 * @param approved - whether the reviewer approved the card.
 * @returns the card and whether the state changed.
 */
async reviewTeam(root: string, id: CardId, approved: boolean): Promise<{ card: Card; changed: boolean }>

/**
 * Archive a team card: `ready` or `revived` → `archived` (the state machine's
 * retire edges; other states fail loud).
 * @param root - the session workspace root.
 * @param id - the team card id.
 * @returns the card in its new state, the previous state, and the file path.
 */
async archiveTeam(root: string, id: CardId): Promise<{ card: Card; from: CardStatus; path: string }>

/**
 * Revive an archived team card: `archived` → `revived`.
 * @param root - the session workspace root.
 * @param id - the team card id.
 * @returns the card in its new state, the previous state, and the file path.
 */
async reviveTeam(root: string, id: CardId): Promise<{ card: Card; from: CardStatus; path: string }>

/**
 * The team work tree's porcelain status — what a commit would carry.
 * @param root - the session workspace root.
 * @returns the non-empty porcelain lines.
 */
async teamStatus(root: string): Promise<string[]>

/**
 * Stage and commit the team work tree (the human review point: review the
 * status, then commit). Fails loud when nothing is staged or git rejects.
 * @param root - the session workspace root.
 * @param message - the commit message.
 * @returns the raw commit output.
 */
async teamCommit(root: string, message: string): Promise<string>

/**
 * The wiki documents under the team library's `docs/`, repository-relative.
 * @param root - the session workspace root.
 * @returns the sorted doc paths.
 */
async listTeamDocs(root: string): Promise<string[]>

/**
 * Read one wiki document.
 * @param root - the session workspace root.
 * @param docPath - the repository-relative doc path (`docs/...`).
 * @returns the document text.
 */
async readTeamDoc(root: string, docPath: string): Promise<string>

/**
 * The workspace's aggregated heat ledger: which cards were consumed by which
 * sessions, projected from `kb/injected` events (see {@link HeatLedger}).
 * @param root - the session workspace root.
 * @returns the per-card heat rows, card-id ascending.
 */
async heat(root: string): Promise<HeatRow[]>

/**
 * The freshness pending-review list for one workspace (see
 * {@link freshnessReview}).
 * @param root - the session workspace root.
 * @param today - the reference date `YYYY-MM-DD` (defaults to today, local).
 * @returns the review list.
 */
freshnessReview(root: string, today?: string): Promise<FreshnessReview>
```

Source: [`packages/kb/kb-core/src/index.ts:262`](../../packages/kb/kb-core/src/index.ts)
<!-- END GENERATED cordis-surface -->
