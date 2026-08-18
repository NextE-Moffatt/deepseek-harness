/**
 * `ctx.kb`: the milestone-1 knowledge-base service — card model, personal
 * library storage (`<workspace>/<cardsPath>/<tier>/<id>.md`), the promotion
 * state machine, FTS5 search with the explicit scan degradation contract,
 * incremental ingest, and the `kb_write` / `kb_read` / `kb_search` /
 * `kb_promote` tools. Tools append the `kb/*` session events; the service
 * methods stay session-free so future plugins (governance, recap) can drive
 * the same seam.
 * @module @deepseek-ai/dsh-kb-core
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import { importDir as runImport, type ImportOptions, type IngestResult } from './ingest.ts'
import { assertTransition } from './lifecycle.ts'
import { CardIndex, openCardIndex, scanSearch, type SearchOutcome, type SearchRequest } from './search.ts'
import { PersonalCardStore, type CardFileInfo } from './store.ts'
import { registerKbTools } from './tools.ts'
import type { Card, CardId, CardStatus, CardTier, CardType } from './types.ts'

export type * from './types.ts'
export {
  CARD_LIBRARIES, CARD_STATUSES, CARD_TIERS, CARD_TYPES,
  isCardLibrary, isCardStatus, isCardTier, isCardType, isValidDateString,
  parseCard, serializeCard,
} from './card.ts'
export { assertTransition, canTransition, CARD_TRANSITIONS } from './lifecycle.ts'
export {
  CardIndex, KB_SEARCH_APPLICATION_ID, KB_SEARCH_SCHEMA_VERSION,
  openCardIndex, scanSearch,
} from './search.ts'
export type { SearchHit, SearchOutcome, SearchRequest } from './search.ts'
export { PersonalCardStore } from './store.ts'
export type { CardFileInfo, CardParseFailure } from './store.ts'
export { importDir } from './ingest.ts'
export type { ImportOptions, IngestResult } from './ingest.ts'
export { registerKbTools } from './tools.ts'

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
}

/** The resolved kb configuration, all fields concrete. */
export interface ResolvedKbConfig {
  /** Library path relative to the session workspace root. */
  cardsPath: string
  /** Search index database path relative to the session workspace root. */
  indexPath: string
  /** Days added to today when a card's 有效期 is omitted. */
  cardTtlDays: number
}

/** Default library path relative to the session workspace root. */
export const DEFAULT_CARDS_PATH = 'kb/cards'
/** Default search index path relative to the session workspace root. */
export const DEFAULT_INDEX_PATH = 'kb/.kb-index.sqlite'
/** Default 有效期 horizon in days. */
export const DEFAULT_CARD_TTL_DAYS = 90

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
  if (typeof cardsPath !== 'string' || cardsPath === '' || !isSafeRelativePath(cardsPath)) {
    throw new Error(`KbConfig.cardsPath must be a non-empty relative path without "..", got ${JSON.stringify(cardsPath)}`)
  }
  if (typeof indexPath !== 'string' || indexPath === '' || !isSafeRelativePath(indexPath)) {
    throw new Error(`KbConfig.indexPath must be a non-empty relative path without "..", got ${JSON.stringify(indexPath)}`)
  }
  if (!Number.isSafeInteger(cardTtlDays) || cardTtlDays < 1) {
    throw new Error(`KbConfig.cardTtlDays must be a positive integer, got ${JSON.stringify(cardTtlDays)}`)
  }
  return { cardsPath, indexPath, cardTtlDays }
}

/** Local date as `YYYYMMDD`, the id-sequence key. */
function compactDateKey(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
}

/** Date `days` from today as `YYYY-MM-DD`, the 有效期 default. */
function dateStringInDays(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
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

/**
 * `ctx.kb`: owns the personal library seam — card write/read, promotion,
 * search, and incremental ingest — plus the milestone-1 tools.
 */
export class KbService extends Service {
  static inject = ['tools']

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
  }

  /** The personal library store for one workspace root. */
  private store(root: string): PersonalCardStore {
    return new PersonalCardStore(resolve(root), this.config.cardsPath)
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
   * Search one library: FTS5 BM25 with structured filters when the index is
   * available, otherwise a deterministic full-library scan with an explicit
   * `mode: 'scan'` note. Results are always real card files.
   * @param root - the session workspace root.
   * @param request - the retrieval request.
   * @returns the retrieval outcome with its mode.
   */
  async search(root: string, request: SearchRequest): Promise<SearchOutcome> {
    const listed = await this.store(root).list()
    for (const failure of listed.failures) {
      this.ctx.logger.debug('dsh-kb-core: ignoring unparseable card file %s: %s', failure.path, failure.message)
    }
    try {
      const index = await this.indexFor(root)
      index.sync(listed.cards)
      const found = index.search(request)
      return { mode: 'fts', total: found.total, hits: found.hits }
    } catch (error) {
      this.ctx.logger.warn('dsh-kb-core: FTS5 index unavailable for %s, degrading to scan: %o', root, error)
      const hits = scanSearch(listed.cards, request)
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
   * Run the incremental ingest over a source directory into the library at
   * `options.root` (see {@link importDir}).
   * @param options - import options.
   * @returns the import outcome.
   */
  importDir(options: ImportOptions): Promise<IngestResult> {
    return runImport(this.store(options.root), options)
  }
}

export default KbService
