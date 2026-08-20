/**
 * `ctx.kb`: the knowledge-base service — card model, personal library storage
 * (`<workspace>/<cardsPath>/<tier>/<id>.md`), the promotion state machine,
 * FTS5 search with the explicit scan degradation contract, incremental
 * ingest, the `kb_write` / `kb_read` / `kb_search` / `kb_promote` tools, the
 * team git library with the dual-gate governance and freshness tool sets, the
 * heat telemetry projection, the recap blind-spot scan (`kb_recap` plus the
 * optional scheduler), and the kb methodology skills. Tools append the `kb/*`
 * session events; the service methods stay session-free so future plugins can
 * drive the same seam.
 * @module @deepseek-ai/dsh-kb-core
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { isAbsolute, resolve } from 'node:path'
import { freshnessReview, registerFreshnessSchedule } from './freshness.ts'
import { evaluateGate } from './govern.ts'
import type { FreshnessReview } from './govern.ts'
import { registerGovernTools, registerTeamWriteApproval } from './govern-tools.ts'
import { applyCardEdit, changedFields, validateEditPatch } from './edit.ts'
import type { ValidatedCardEditPatch } from './edit.ts'
import { compactDateKey, dateStringInDays } from './date.ts'
import { importDir as runImport, type ImportOptions, type IngestResult } from './ingest.ts'
import { registerKbInjection } from './inject.ts'
import { assertTransition } from './lifecycle.ts'
import { resolvePacks } from './pack.ts'
import { runRecapScan, registerRecapSchedule, type RecapScanResult } from './recap.ts'
import { registerRecapTools } from './recap-tools.ts'
import { CardIndex, openCardIndex, scanSearch, type SearchOutcome, type SearchRequest, type SearchableCard } from './search.ts'
import { registerKbSkills } from './skills.ts'
import { PersonalCardStore, type CardFileInfo } from './store.ts'
import { GitRunner } from './gitops.ts'
import { TeamCardStore, type TeamCardFileInfo } from './team.ts'
import { aggregateHeat, HeatLedger, registerKbTelemetry, type HeatRow } from './telemetry.ts'
import { registerKbTools } from './tools.ts'
import type { Card, CardEditPatch, CardId, CardLibrary, CardStatus, CardTier, CardType, KnowledgePack } from './types.ts'

export type * from './types.ts'
export { compactDateKey, dateStringInDays, todayString } from './date.ts'
export {
  CARD_LIBRARIES, CARD_STATUSES, CARD_TIERS, CARD_TYPES,
  isCardLibrary, isCardStatus, isCardTier, isCardType, isValidDateString,
  parseCard, serializeCard,
} from './card.ts'
export { assertTransition, canTransition, CARD_TRANSITIONS } from './lifecycle.ts'
export {
  KB_PACK_SECTION, KB_PACK_SECTION_ORDER, foldInjected, hasInjectedPack,
  renderCardSection, resolvePacks, selectPackCards,
} from './pack.ts'
export type { PackEntry } from './pack.ts'
export {
  CardIndex, KB_SEARCH_APPLICATION_ID, KB_SEARCH_SCHEMA_VERSION,
  openCardIndex, scanSearch,
} from './search.ts'
export type { SearchHit, SearchOutcome, SearchRequest } from './search.ts'
export { PersonalCardStore } from './store.ts'
export type { CardFileInfo, CardParseFailure } from './store.ts'
export { applyCardEdit, changedFields, validateEditPatch } from './edit.ts'
export type { ValidatedCardEditPatch } from './edit.ts'
export { TeamCardStore } from './team.ts'
export type { TeamCardFileInfo } from './team.ts'
export { GitRunner } from './gitops.ts'
export type { GitExec, GitRunResult } from './gitops.ts'
export {
  evaluateGate, freshnessPosition, gradeCard, partitionReview,
  recommendFreshness, renderReviewList, toReviewEntry,
} from './govern.ts'
export type {
  FreshnessPosition, FreshnessRecommendation, FreshnessReview, GateVerdict, ReviewEntry,
} from './govern.ts'
export { createFreshnessProducer, freshnessReview, freshnessReviewText, registerFreshnessSchedule } from './freshness.ts'
export { aggregateHeat, HeatLedger, projectInjectedHeat, registerKbTelemetry } from './telemetry.ts'
export type { HeatEntry, HeatRow } from './telemetry.ts'
export {
  DEFAULT_RECAP_LIMIT, RECAP_EXCERPT_MAX_CHARS, RecapCheckpoint,
  consumedCardIds, consumedKnowledge, createRecapProducer, detectBlindSpots,
  isBlindSpot, lastEventTime, liveRecapLogSource, mergePositions,
  producedCard, projectRecapScans, recapEventPayload, registerRecapSchedule,
  renderRecapList, renderSessionExcerpt, runRecapScan,
} from './recap.ts'
export type { BlindSpotEntry, RecapCandidate, RecapLogSource, RecapScanResult, RecapSessionLog } from './recap.ts'
export { registerRecapTools } from './recap-tools.ts'
export {
  CARD_WRITING_SKILL, PACK_BUILDING_SKILL, RECAP_FLOW_SKILL,
  cardWritingSkillContent, packBuildingSkillContent, recapFlowSkillContent, registerKbSkills,
} from './skills.ts'
export { injectPacks, registerKbInjection } from './inject.ts'
export { importDir } from './ingest.ts'
export type { ImportOptions, IngestResult } from './ingest.ts'
export { registerKbTools } from './tools.ts'
export { registerGovernTools, registerTeamWriteApproval } from './govern-tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The knowledge-base service (see {@link KbService}). */
    kb: KbService
  }
}

/** Deployment configuration of the kb service. */
export interface KbConfig {
  /** Library path relative to the session workspace root (default `kb/cards`). */
  cardsPath?: string
  /** Search index database path relative to the session workspace root (default `kb/.kb-index.sqlite`). */
  indexPath?: string
  /** Days added to today when a card's 有效期 is omitted (default 90). */
  cardTtlDays?: number
  /** Team library git work tree path (absolute, or relative to the session workspace root); absent disables the team library. */
  teamRepoPath?: string
  /** Heat ledger path relative to the session workspace root (default `kb/.kb-heat.jsonl`). */
  heatPath?: string
  /** Days ahead of 有效期 that count as "expiring soon" in the freshness review (default 14). */
  freshnessWarningDays?: number
  /** Days between scheduled freshness scans; 0 disables the scheduler (default 0). */
  freshnessIntervalDays?: number
  /** Route team-library write tools through the approval `ask` gate (default true). */
  teamWriteApproval?: boolean
  /** Recap checkpoint path relative to the session workspace root (default `kb/.kb-recap.jsonl`). */
  recapPath?: string
  /** Days between scheduled recap scans; 0 disables the scheduler (default 0). */
  recapIntervalDays?: number
  /** Knowledge packs injected at session start (default none). */
  packs?: KnowledgePack[]
}

/** The resolved kb configuration, all fields concrete. */
export interface ResolvedKbConfig {
  /** Library path relative to the session workspace root. */
  cardsPath: string
  /** Search index database path relative to the session workspace root. */
  indexPath: string
  /** Days added to today when a card's 有效期 is omitted. */
  cardTtlDays: number
  /** Team library git work tree path; undefined disables the team library. */
  teamRepoPath?: string
  /** Heat ledger path relative to the session workspace root. */
  heatPath: string
  /** Days ahead of 有效期 that count as "expiring soon". */
  freshnessWarningDays: number
  /** Days between scheduled freshness scans; 0 disables the scheduler. */
  freshnessIntervalDays: number
  /** Whether team-library write tools route through the approval `ask` gate. */
  teamWriteApproval: boolean
  /** Recap checkpoint path relative to the session workspace root. */
  recapPath: string
  /** Days between scheduled recap scans; 0 disables the scheduler. */
  recapIntervalDays: number
  /** Validated knowledge packs injected at session start. */
  packs: KnowledgePack[]
}

/** Default library path relative to the session workspace root. */
export const DEFAULT_CARDS_PATH = 'kb/cards'
/** Default search index path relative to the session workspace root. */
export const DEFAULT_INDEX_PATH = 'kb/.kb-index.sqlite'
/** Default heat ledger path relative to the session workspace root. */
export const DEFAULT_HEAT_PATH = 'kb/.kb-heat.jsonl'
/** Default recap checkpoint path relative to the session workspace root. */
export const DEFAULT_RECAP_PATH = 'kb/.kb-recap.jsonl'
/** Default 有效期 horizon in days. */
export const DEFAULT_CARD_TTL_DAYS = 90
/** Default freshness warning window in days. */
export const DEFAULT_FRESHNESS_WARNING_DAYS = 14
/** Default team-write approval gate. */
export const DEFAULT_TEAM_WRITE_APPROVAL = true

/** Whether a configured path is a safe relative path (no absolute roots, no parent traversal). */
function isSafeRelativePath(path: string): boolean {
  return !path.startsWith('/') && !path.startsWith('\\') && !/^[A-Za-z]:/.test(path)
    && !path.split(/[\\/]/).includes('..')
}

/**
 * Resolve and validate the kb configuration; invalid values fail loud at load.
 * @param config - raw configuration.
 * @returns the resolved configuration with defaults applied.
 */
export function resolveConfig(config: KbConfig): ResolvedKbConfig {
  const cardsPath = config.cardsPath ?? DEFAULT_CARDS_PATH
  const indexPath = config.indexPath ?? DEFAULT_INDEX_PATH
  const cardTtlDays = config.cardTtlDays ?? DEFAULT_CARD_TTL_DAYS
  const teamRepoPath = config.teamRepoPath
  const heatPath = config.heatPath ?? DEFAULT_HEAT_PATH
  const freshnessWarningDays = config.freshnessWarningDays ?? DEFAULT_FRESHNESS_WARNING_DAYS
  const freshnessIntervalDays = config.freshnessIntervalDays ?? 0
  const teamWriteApproval = config.teamWriteApproval ?? DEFAULT_TEAM_WRITE_APPROVAL
  const recapPath = config.recapPath ?? DEFAULT_RECAP_PATH
  const recapIntervalDays = config.recapIntervalDays ?? 0
  const packs = resolvePacks(config.packs)
  if (typeof cardsPath !== 'string' || cardsPath === '' || !isSafeRelativePath(cardsPath)) {
    throw new Error(`KbConfig.cardsPath must be a non-empty relative path without "..", got ${JSON.stringify(cardsPath)}`)
  }
  if (typeof indexPath !== 'string' || indexPath === '' || !isSafeRelativePath(indexPath)) {
    throw new Error(`KbConfig.indexPath must be a non-empty relative path without "..", got ${JSON.stringify(indexPath)}`)
  }
  if (teamRepoPath !== undefined && (typeof teamRepoPath !== 'string' || teamRepoPath === '')) {
    throw new Error(`KbConfig.teamRepoPath must be a non-empty path, got ${JSON.stringify(teamRepoPath)}`)
  }
  if (typeof heatPath !== 'string' || heatPath === '' || !isSafeRelativePath(heatPath)) {
    throw new Error(`KbConfig.heatPath must be a non-empty relative path without "..", got ${JSON.stringify(heatPath)}`)
  }
  if (typeof recapPath !== 'string' || recapPath === '' || !isSafeRelativePath(recapPath)) {
    throw new Error(`KbConfig.recapPath must be a non-empty relative path without "..", got ${JSON.stringify(recapPath)}`)
  }
  if (!Number.isSafeInteger(cardTtlDays) || cardTtlDays < 1) {
    throw new Error(`KbConfig.cardTtlDays must be a positive integer, got ${JSON.stringify(cardTtlDays)}`)
  }
  if (!Number.isSafeInteger(freshnessWarningDays) || freshnessWarningDays < 0) {
    throw new Error(`KbConfig.freshnessWarningDays must be a non-negative integer, got ${JSON.stringify(freshnessWarningDays)}`)
  }
  if (!Number.isSafeInteger(freshnessIntervalDays) || freshnessIntervalDays < 0) {
    throw new Error(`KbConfig.freshnessIntervalDays must be a non-negative integer, got ${JSON.stringify(freshnessIntervalDays)}`)
  }
  if (!Number.isSafeInteger(recapIntervalDays) || recapIntervalDays < 0) {
    throw new Error(`KbConfig.recapIntervalDays must be a non-negative integer, got ${JSON.stringify(recapIntervalDays)}`)
  }
  if (typeof teamWriteApproval !== 'boolean') {
    throw new Error(`KbConfig.teamWriteApproval must be a boolean, got ${JSON.stringify(teamWriteApproval)}`)
  }
  return {
    cardsPath,
    indexPath,
    cardTtlDays,
    ...teamRepoPath === undefined ? {} : { teamRepoPath },
    heatPath,
    freshnessWarningDays,
    freshnessIntervalDays,
    teamWriteApproval,
    recapPath,
    recapIntervalDays,
    packs,
  }
}

/** Input of a card write; values are validated at the tool boundary. */
export interface WriteCardInput {
  /** Tier directory to write into. */
  tier: CardTier
  /** Card id; generated as `{type}-YYYYMMDD-{seq}` when omitted. */
  id?: CardId
  /** Card type. */
  type: CardType
  /** One-sentence title. */
  title: string
  /** When to use this card. */
  适用条件: string
  /** The conclusion in one paragraph. */
  核心结论: string
  /** Executable positive actions. */
  应做: string[]
  /** Executable negative actions. */
  不应做: string[]
  /** Optional counter-example. */
  反例?: string
  /** Optional objective evidence. */
  来源?: string
  /** Knowledge owner. */
  责任人: string
  /** Expiry date `YYYY-MM-DD`; defaults to `now + cardTtlDays` when omitted. */
  有效期?: string
  /** Tags. */
  标签: string[]
}

/** The outcome of a card write: always a personal-library draft. */
export interface CardWriteResult {
  /** The written card. */
  card: Card
  /** The tier directory written into. */
  tier: CardTier
  /** Absolute path of the written file. */
  path: string
}

/** The outcome of a promotion transition. */
export interface PromoteResult {
  /** The card in its new state. */
  card: Card
  /** The state before the transition. */
  from: CardStatus
  /** The state after the transition. */
  to: CardStatus
  /** The optional objective signal carried into the `kb/promote` event. */
  evidence?: string
  /** Absolute path of the rewritten file. */
  path: string
}

/** Edit options: the optimistic concurrency guard and the team approval signal. */
export interface EditCardOptions {
  /** Expected on-disk file identity (mtime ms + size) observed when the card
   * was read; a mismatch fails the edit with a conflict error. */
  expected?: { mtime: number; size: number }
  /** Explicit approval for a team-card edit when `KbConfig.teamWriteApproval`
   * is true — the human workbench's approval signal carried with the operation. */
  approved?: boolean
}

/** The outcome of a card-content edit. */
export interface CardEditResult {
  /** The card in its edited state. */
  card: Card
  /** The library the card lives in. */
  library: CardLibrary
  /** The tier directory for personal cards, or `team` for team cards. */
  tier: CardTier | 'team'
  /** Absolute path of the rewritten file. */
  path: string
  /** The changed content fields; empty when the edit changed nothing (no write). */
  fields: string[]
}

/** Write options for a team doc: the optimistic identity and the team approval signal. */
export interface TeamDocWriteOptions {
  /** Expected on-disk file identity (mtime ms + size) observed when the doc
   * was read; a mismatch fails the write with a conflict error. */
  expected?: { mtime: number; size: number }
  /** Explicit approval for the team write when `KbConfig.teamWriteApproval`
   * is true — the human workbench's approval signal carried with the operation. */
  approved?: boolean
}

/** The outcome of a team doc write. */
export interface TeamDocWriteResult {
  /** The repository-relative doc path (`docs/...`). */
  path: string
  /** File mtime in epoch milliseconds after the write. */
  mtime: number
  /** File size in bytes after the write. */
  size: number
}

/**
 * `ctx.kb`: owns the personal library seam — card write/read, promotion,
 * search, and incremental ingest — plus the milestone-1 tools and the
 * knowledge-pack injection wiring (session-start trigger + `kb:pack` section).
 */
export class KbService extends Service {
  static inject = ['tools', 'systemPrompt']

  /** The resolved configuration. */
  readonly config: ResolvedKbConfig

  /** Open search indexes keyed by resolved database path, closed on disposal. */
  private readonly indexes = new Map<string, CardIndex>()

  /**
   * @param ctx - registrant context.
   * @param config - deployment configuration; defaults apply per field.
   */
  constructor(ctx: Context, config: KbConfig = {}) {
    super(ctx, 'kb')
    this.config = resolveConfig(config)
    ctx.effect(() => () => {
      for (const index of this.indexes.values()) index.close()
      this.indexes.clear()
    }, 'dsh-kb-core: close per-root search indexes')
    registerKbTools(ctx, this)
    registerKbInjection(ctx, this)
    registerGovernTools(ctx, this)
    registerTeamWriteApproval(ctx, this)
    registerKbTelemetry(ctx, this)
    registerFreshnessSchedule(ctx, this)
    registerRecapTools(ctx, this)
    registerRecapSchedule(ctx, this)
    registerKbSkills(ctx)
  }

  /** The personal library store for one workspace root. */
  private store(root: string): PersonalCardStore {
    return new PersonalCardStore(resolve(root), this.config.cardsPath)
  }

  /** The absolute team repository path for one workspace root (config-relative paths resolve against the root).
   * @param root - the session workspace root.
   * @returns the absolute team repository path.
   */
  teamRepoRoot(root: string): string {
    const configured = this.config.teamRepoPath
    if (configured === undefined) {
      throw new Error('team library is not configured (set KbConfig.teamRepoPath)')
    }
    return isAbsolute(configured) ? configured : resolve(root, configured)
  }

  /** The team library store for one workspace root; fails loud when not configured. */
  private teamStore(root: string): TeamCardStore {
    return new TeamCardStore(this.teamRepoRoot(root))
  }

  /** The team repository's git surface for one workspace root. */
  private teamGit(root: string): GitRunner {
    return new GitRunner(this.teamRepoRoot(root))
  }

  /** Open (and cache) the search index for one workspace root. */
  private async indexFor(root: string): Promise<CardIndex> {
    const path = resolve(root, this.config.indexPath)
    const cached = this.indexes.get(path)
    if (cached !== undefined) return cached
    const index = new CardIndex(await openCardIndex(path))
    this.indexes.set(path, index)
    return index
  }

  /**
   * Write a new personal-library draft card, generating the id when omitted.
   * @param root - the session workspace root.
   * @param input - the card to write (values validated at the tool boundary).
   * @returns the written card, tier, and absolute path.
   */
  async writeCard(root: string, input: WriteCardInput): Promise<CardWriteResult> {
    const store = this.store(root)
    const id = input.id ?? await store.nextId(input.type, compactDateKey(new Date()))
    const expiresAt = input.有效期 ?? dateStringInDays(this.config.cardTtlDays)
    const card: Card = {
      id,
      type: input.type,
      title: input.title,
      库: 'personal',
      状态: 'draft',
      适用条件: input.适用条件,
      核心结论: input.核心结论,
      应做: input.应做,
      不应做: input.不应做,
      ...input.反例 === undefined ? {} : { 反例: input.反例 },
      ...input.来源 === undefined ? {} : { 来源: input.来源 },
      责任人: input.责任人,
      有效期: expiresAt,
      标签: input.标签,
    }
    const path = await store.write(card, input.tier)
    return { card, tier: input.tier, path }
  }

  /**
   * Read one card by id across all tiers.
   * @param root - the session workspace root.
   * @param id - the card id.
   * @returns the card file info; throws when no tier holds the id.
   */
  async readCard(root: string, id: CardId): Promise<CardFileInfo> {
    const info = await this.store(root).find(id)
    if (info === undefined) throw new Error(`card not found: ${id}`)
    return info
  }

  /**
   * Search the personal and team libraries: one FTS5 BM25 query over the
   * unified index when it is available, otherwise a deterministic
   * full-library scan with an explicit `mode: 'scan'` note. The team library
   * joins when `teamRepoPath` is configured; a configured-but-broken team
   * repository fails loud. Results are always real card files.
   * @param root - the session workspace root.
   * @param request - the retrieval request.
   * @returns the retrieval outcome with its mode.
   */
  async search(root: string, request: SearchRequest): Promise<SearchOutcome> {
    const entries: SearchableCard[] = []
    const listed = await this.store(root).list()
    for (const failure of listed.failures) {
      this.ctx.logger.debug('dsh-kb-core: ignoring unparseable card file %s: %s', failure.path, failure.message)
    }
    for (const card of listed.cards) {
      entries.push({ library: 'personal', ...card })
    }
    if (this.config.teamRepoPath !== undefined) {
      const team = await this.teamStore(root).list()
      for (const failure of team.failures) {
        this.ctx.logger.debug('dsh-kb-core: ignoring unparseable team card file %s: %s', failure.path, failure.message)
      }
      for (const card of team.cards) {
        entries.push({ library: 'team', card: card.card, path: card.path, mtime: card.mtime, size: card.size })
      }
    }
    try {
      const index = await this.indexFor(root)
      index.sync(entries)
      const found = index.search(request)
      return { mode: 'fts', total: found.total, hits: found.hits }
    } catch (error) {
      this.ctx.logger.warn('dsh-kb-core: FTS5 index unavailable for %s, degrading to scan: %o', root, error)
      const hits = scanSearch(entries, request)
      return {
        mode: 'scan',
        total: hits.length,
        hits: hits.slice(0, request.limit),
        note: 'FTS5 index unavailable; results are a deterministic full-library scan',
      }
    }
  }

  /**
   * Apply a promotion transition: assert the state machine, rewrite the card
   * file, and return the new state. The caller (tool) appends `kb/promote`.
   * @param root - the session workspace root.
   * @param id - the card id.
   * @param target - the requested next state (promotion subset: `pending` or `ready`).
   * @param evidence - optional objective signal.
   * @returns the card in its new state plus the transition.
   */
  async promote(root: string, id: CardId, target: CardStatus, evidence?: string): Promise<PromoteResult> {
    const store = this.store(root)
    const info = await this.readCard(root, id)
    const to = assertTransition(info.card.状态, target)
    const card: Card = { ...info.card, 状态: to }
    const path = await store.rewrite(card, info.tier)
    return { card, from: info.card.状态, to, ...evidence === undefined ? {} : { evidence }, path }
  }

  /**
   * Edit one card's content across the personal and team libraries: validate
   * the patch at the wire boundary, apply it preserving `id` / `库` / `状态`,
   * guard against concurrent modification via the expected file identity, and
   * rewrite in place. A team-card edit requires `options.approved` when
   * `KbConfig.teamWriteApproval` is set. The caller (workbench) appends
   * `kb/edit` when the result's `fields` are non-empty.
   * @param root - the session workspace root.
   * @param id - the card id.
   * @param patch - the content-field patch.
   * @param options - the optimistic guard and the team approval signal.
   * @returns the edited card with the changed field names.
   */
  async editCard(root: string, id: CardId, patch: CardEditPatch, options?: EditCardOptions): Promise<CardEditResult> {
    const validated = validateEditPatch(patch)
    const personal = await this.store(root).find(id)
    if (personal !== undefined) {
      return this.planAndWrite(root, personal.card, personal.tier, personal.mtime, personal.size, validated, options, false)
    }
    const team = await this.teamCard(root, id)
    if (team !== undefined) {
      return this.planAndWrite(root, team.card, 'team', team.mtime, team.size, validated, options, true)
    }
    throw new Error(`card not found: ${id}`)
  }

  /** Shared edit application: diff, conflict guard, team approval gate, and the rewrite. */
  private async planAndWrite(
    root: string,
    card: Card,
    tier: CardTier | 'team',
    mtime: number,
    size: number,
    patch: ValidatedCardEditPatch,
    options: EditCardOptions | undefined,
    isTeam: boolean,
  ): Promise<CardEditResult> {
    const after = applyCardEdit(card, patch)
    const fields = changedFields(card, after)
    if (fields.length === 0) {
      return {
        card: after,
        library: card.库,
        tier,
        path: tier === 'team' ? this.teamStore(root).cardPath(card.id) : this.store(root).cardPath(tier, card.id),
        fields,
      }
    }
    const expected = options?.expected
    if (expected !== undefined && (mtime !== expected.mtime || size !== expected.size)) {
      throw new Error(`卡片已被其他会话修改，请刷新后重试（${card.id}）`)
    }
    if (isTeam && this.config.teamWriteApproval && options?.approved !== true) {
      throw new Error(`团队卡片编辑需经审批（KbConfig.teamWriteApproval）：${card.id}`)
    }
    const path = tier === 'team'
      ? await this.teamStore(root).rewrite(after)
      : await this.store(root).rewrite(after, tier)
    return { card: after, library: card.库, tier, path, fields }
  }

  /**
   * Run the incremental ingest over a source directory into the library at
   * `options.root` (see {@link importDir}). A wrapped card's 有效期 defaults
   * to `now + cardTtlDays` when the options omit it.
   * @param options - import options.
   * @returns the import outcome.
   */
  importDir(options: ImportOptions): Promise<IngestResult> {
    return runImport(this.store(options.root), {
      ...options,
      cardTtlDays: options.cardTtlDays ?? this.config.cardTtlDays,
    })
  }

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
  async promoteToTeam(root: string, id: CardId, evidence: readonly string[]): Promise<{ card: Card; path: string }> {
    const personal = this.store(root)
    const info = await personal.find(id)
    const gate = evaluateGate(info?.card, evidence)
    if (gate.verdict === 'BLOCK' || info === undefined) {
      throw new Error(`kb_gate_check BLOCK: ${gate.reasons.join('；')}`)
    }
    const team = this.teamStore(root)
    const card: Card = { ...info.card, 库: 'team', 状态: 'pending' }
    const path = await team.write(card)
    await personal.remove(info.tier, id)
    return { card, path }
  }

  /**
   * Look up a card in the personal library, returning undefined when no tier
   * holds it.
   * @param root - the session workspace root.
   * @param id - the card id.
   * @returns the card file info, or undefined.
   */
  async personalCard(root: string, id: CardId): Promise<CardFileInfo | undefined> {
    return this.store(root).find(id)
  }

  /**
   * Look up a card in the team library, returning undefined when the library
   * does not hold it (or is not configured).
   * @param root - the session workspace root.
   * @param id - the card id.
   * @returns the team card file info, or undefined.
   */
  async teamCard(root: string, id: CardId): Promise<TeamCardFileInfo | undefined> {
    if (this.config.teamRepoPath === undefined) return undefined
    return this.teamStore(root).find(id)
  }

  /**
   * Read one team-library card.
   * @param root - the session workspace root.
   * @param id - the card id.
   * @returns the card file info; throws when the team library does not hold it.
   */
  async teamRead(root: string, id: CardId): Promise<TeamCardFileInfo> {
    const info = await this.teamCard(root, id)
    if (info === undefined) throw new Error(`team card not found: ${id}`)
    return info
  }

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
  async reviewTeam(root: string, id: CardId, approved: boolean): Promise<{ card: Card; changed: boolean }> {
    const team = this.teamStore(root)
    const info = await this.teamRead(root, id)
    if (!approved) return { card: info.card, changed: false }
    if (info.card.库 !== 'team' || info.card.状态 !== 'pending') {
      throw new Error(`kb_review requires a team card in status pending, got ${info.card.状态}`)
    }
    const card: Card = { ...info.card, 状态: assertTransition(info.card.状态, 'ready') }
    await team.rewrite(card)
    return { card, changed: true }
  }

  /**
   * Archive a team card: `ready` or `revived` → `archived` (the state machine's
   * retire edges; other states fail loud).
   * @param root - the session workspace root.
   * @param id - the team card id.
   * @returns the card in its new state, the previous state, and the file path.
   */
  async archiveTeam(root: string, id: CardId): Promise<{ card: Card; from: CardStatus; path: string }> {
    const team = this.teamStore(root)
    const info = await this.teamRead(root, id)
    const card: Card = { ...info.card, 状态: assertTransition(info.card.状态, 'archived') }
    await team.rewrite(card)
    return { card, from: info.card.状态, path: info.path }
  }

  /**
   * Revive an archived team card: `archived` → `revived`.
   * @param root - the session workspace root.
   * @param id - the team card id.
   * @returns the card in its new state, the previous state, and the file path.
   */
  async reviveTeam(root: string, id: CardId): Promise<{ card: Card; from: CardStatus; path: string }> {
    const team = this.teamStore(root)
    const info = await this.teamRead(root, id)
    const card: Card = { ...info.card, 状态: assertTransition(info.card.状态, 'revived') }
    await team.rewrite(card)
    return { card, from: info.card.状态, path: info.path }
  }

  /**
   * The team work tree's porcelain status — what a commit would carry.
   * @param root - the session workspace root.
   * @returns the non-empty porcelain lines.
   */
  async teamStatus(root: string): Promise<string[]> {
    return this.teamGit(root).status()
  }

  /**
   * Stage and commit the team work tree (the human review point: review the
   * status, then commit). Fails loud when nothing is staged or git rejects.
   * @param root - the session workspace root.
   * @param message - the commit message.
   * @returns the raw commit output.
   */
  async teamCommit(root: string, message: string): Promise<string> {
    const git = this.teamGit(root)
    await git.stage()
    return git.commit(message)
  }

  /**
   * The wiki documents under the team library's `docs/`, repository-relative.
   * @param root - the session workspace root.
   * @returns the sorted doc paths.
   */
  async listTeamDocs(root: string): Promise<string[]> {
    return this.teamStore(root).listDocs()
  }

  /**
   * Read one wiki document.
   * @param root - the session workspace root.
   * @param docPath - the repository-relative doc path (`docs/...`).
   * @returns the document text.
   */
  async readTeamDoc(root: string, docPath: string): Promise<string> {
    return this.teamStore(root).readDoc(docPath)
  }

  /**
   * The identity of one wiki document (mtime + size), the write conflict
   * guard's expected values. Fails loud when the doc is missing or escapes
   * `docs/`.
   * @param root - the session workspace root.
   * @param docPath - the repository-relative doc path (`docs/...`).
   * @returns the repository-relative path and the file identity.
   */
  async teamDocInfo(root: string, docPath: string): Promise<{ path: string; mtime: number; size: number }> {
    const info = await this.teamStore(root).docInfo(docPath)
    return { path: docPath, ...info }
  }

  /**
   * Write (overwrite) one team wiki document: refuse paths that escape `docs/`
   * or lack a `.md` extension, guard against concurrent modification via the
   * expected file identity, and require `options.approved` when
   * `KbConfig.teamWriteApproval` is set (docs live only in the team library).
   * The caller (workbench) appends `kb/doc-write` after the write succeeds.
   * @param root - the session workspace root.
   * @param docPath - the repository-relative doc path (`docs/...`).
   * @param content - the document text (non-empty).
   * @param options - the optimistic guard and the team approval signal.
   * @returns the repository-relative path and the file identity after the write.
   */
  async writeTeamDoc(root: string, docPath: string, content: string, options?: TeamDocWriteOptions): Promise<TeamDocWriteResult> {
    const store = this.teamStore(root)
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error(`team doc content must be a non-empty string, got ${JSON.stringify(content)}`)
    }
    const current = await store.docInfo(docPath)
    const expected = options?.expected
    if (expected !== undefined && (current.mtime !== expected.mtime || current.size !== expected.size)) {
      throw new Error(`文档已被其他会话修改，请刷新后重试（${docPath}）`)
    }
    if (this.config.teamWriteApproval && options?.approved !== true) {
      throw new Error(`团队文档写入需经审批（KbConfig.teamWriteApproval）：${docPath}`)
    }
    const written = await store.writeDoc(docPath, content)
    return { path: docPath, mtime: written.mtime, size: written.size }
  }

  /**
   * Remove one team wiki document: refuse paths that escape `docs/` or lack a
   * `.md` extension, require `options.approved` when `KbConfig.teamWriteApproval`
   * is set, and fail loud when the doc is already gone. The caller (workbench)
   * appends `kb/doc-remove` after the removal succeeds; the git work tree
   * retains the deleted file's history through `kb_team_commit`.
   * @param root - the session workspace root.
   * @param docPath - the repository-relative doc path (`docs/...`).
   * @param options - the team approval signal.
   * @returns the repository-relative path removed.
   */
  async removeTeamDoc(root: string, docPath: string, options?: TeamDocWriteOptions): Promise<{ path: string }> {
    const store = this.teamStore(root)
    if (this.config.teamWriteApproval && options?.approved !== true) {
      throw new Error(`团队文档删除需经审批（KbConfig.teamWriteApproval）：${docPath}`)
    }
    await store.removeDoc(docPath)
    return { path: docPath }
  }

  /**
   * The workspace's aggregated heat ledger: which cards were consumed by which
   * sessions, projected from `kb/injected` events (see {@link HeatLedger}).
   * @param root - the session workspace root.
   * @returns the per-card heat rows, card-id ascending.
   */
  async heat(root: string): Promise<HeatRow[]> {
    return aggregateHeat(await new HeatLedger(resolve(root, this.config.heatPath)).readAll())
  }

  /**
   * The freshness pending-review list for one workspace (see
   * {@link freshnessReview}).
   * @param root - the session workspace root.
   * @param today - the reference date `YYYY-MM-DD` (defaults to today, local).
   * @returns the review list.
   */
  freshnessReview(root: string, today?: string): Promise<FreshnessReview> {
    return freshnessReview(this.ctx, this, root, today)
  }

  /**
   * Run one recap scan for one workspace: detect the unrecorded blind spots
   * (sessions that consumed knowledge but produced no card), list up to
   * `limit`, and record the listed positions (see {@link runRecapScan}). The
   * caller (tool) appends the `kb/recap` event when positions were recorded.
   * @param root - the session workspace root.
   * @param limit - the listing cap (a positive integer).
   * @returns the scan outcome.
   */
  async recap(root: string, limit: number): Promise<RecapScanResult> {
    return runRecapScan(this.ctx, this, root, limit)
  }
}

export default KbService
