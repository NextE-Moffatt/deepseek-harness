# Knowledge Base

English | [中文](kb.zh.md)

The personal knowledge library: `ctx.kb` owns card write/read, the promotion state machine, FTS5 search with the scan degradation contract, incremental ingest, and knowledge-pack injection at session start, and registers the `kb_write` / `kb_read` / `kb_search` / `kb_promote` tools. The [design Agent Note](../../.agents/notes/implemented/feature/2026-08-18-dsh-kb-package-group-milestone-1.md) owns the package-group decision and the [injection Agent Note](../../.agents/notes/implemented/feature/2026-08-18-dsh-kb-inject.md) owns the knowledge-pack decision; this page records the exact types from [`packages/kb/kb-core/src/types.ts`](../../packages/kb/kb-core/src/types.ts).

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

The promotion state machine is the closed chain `draft → pending → ready → archived → revived` with `revived → archived`; `kb_promote` exposes only the promotion subset (targets `pending` and `ready`). Card parsing fails loud on unknown keys, missing required fields, malformed dates, and unknown enum values; 应做 / 不应做 sections may be empty for imported cards, while the `kb_write` tool requires at least one item each.

## Search contract

`CardIndex` runs FTS5 `unicode61` (BM25) over a per-library-root database at `kb/.kb-index.sqlite` (`indexPath` config), with a regular `cards` table for structured filters (type / 状态 / tier / tags). CJK/kana runs are char-split in both the index and the query, so substring search works without a segmentation dictionary. The degradation contract is explicit: when the index cannot open, `search` returns deterministic scan-mode results (`mode: 'scan'`) over the same filters with a note — never fabricated answers.

## Session events

State changes are logged: `kb/write` records a tool-performed card write, `kb/promote` records a lifecycle transition, and `kb/injected` records one knowledge-pack injection at session start. All are appended after the underlying operation succeeds, so the model-visible surface replays from the session log; `kb/injected` carries the full rendered card sections, so the `kb:pack` prompt section reconstructs from the log alone. The full payload declarations live in the [persistence catalog](../persistence-catalog.md#kbpromote--log-only).

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
  /** Filter: tier allowlist. */
  tier?: readonly CardTier[]
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

Packs are declared under `KbConfig.packs` and validated at load (unique non-empty names, closed-enum tier/status members, positive integer limits, no unknown keys). At `agent/session-start` the injection listener reads the library synchronously, selects each pack's cards (`tags` must all be present, tier/status allowlists, `archived` excluded by default, id-ascending, capped at `limit`), and appends one `kb/injected` event per pack with the rendered sections. The `kb:pack` prompt section folds those events and renders the pack headers and card blocks for every request. Injection is once per session per pack (the log fold is the guard), so resume and fork inherit the injection and replay reproduces the section byte-identically. Sessions without a workspace skip injection, packs matching no cards append nothing, and per-pack failures log and continue.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxkb--kbservice"></a>

### `ctx.kb` — `KbService`

`ctx.kb`: owns the personal library seam — card write/read, promotion, search, and incremental ingest — plus the milestone-1 tools and the knowledge-pack injection wiring (session-start trigger + `kb:pack` section).

```ts cordis-catalog
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
```

Source: [`packages/kb/kb-core/src/index.ts:183`](../../packages/kb/kb-core/src/index.ts)
<!-- END GENERATED cordis-surface -->
