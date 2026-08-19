/**
 * kb-search: the retrieval layer over the personal and team libraries. The
 * primary path is one SQLite FTS5 index per workspace root (BM25) with
 * structured field filters; the explicit degradation contract falls back to a
 * deterministic full-library scan when the index cannot open. Neither path
 * fabricates results — hits are always real card files.
 * @module @deepseek-ai/dsh-kb-core/search
 */

import type { DatabaseSync } from 'node:sqlite'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { CardFileInfo } from './store.ts'
import type { Card, CardId, CardLibrary, CardStatus, CardTier, CardType } from './types.ts'

/** Current index schema version; incompatible versions reset in place. */
export const KB_SEARCH_SCHEMA_VERSION = 2

/** SQLite application id protecting unrelated databases from resets. */
export const KB_SEARCH_APPLICATION_ID = 0x4b425349

/** Retrieval request: a query plus optional structured field filters. */
export interface SearchRequest {
  /** Full-text query; tokens are AND-joined. */
  query: string
  /** Filter: card type. */
  type?: CardType
  /** Filter: lifecycle state. */
  status?: CardStatus
  /** Filter: personal-library tier. */
  tier?: CardTier
  /** Filter: every listed tag must be present. */
  tags?: readonly string[]
  /** Maximum hits to return. */
  limit: number
}

/** One retrieval hit. */
export interface SearchHit {
  /** Card id. */
  id: CardId
  /** Card title. */
  title: string
  /** Card type. */
  type: CardType
  /** Lifecycle state. */
  status: CardStatus
  /** The library the card lives in. */
  library: CardLibrary
  /**
   * The personal-library tier directory, or the team-library marker `team`
   * (the team library has no tiers).
   */
  tier: CardTier | 'team'
  /** Absolute card file path. */
  path: string
  /** 适用条件 field (the retrieval-hit key). */
  适用条件: string
  /** Tags. */
  标签: string[]
  /** Relevance score: BM25 (negated, higher is better) or the scan score. */
  score: number
}

/** A retrieval outcome with its explicit mode. */
export interface SearchOutcome {
  /** `fts` when the FTS5 index served the query; `scan` under the degradation contract. */
  mode: 'fts' | 'scan'
  /** Total matches before the limit. */
  total: number
  /** The limited hits. */
  hits: SearchHit[]
  /** Model-facing explanation, present only under degradation. */
  note?: string
}

/** One card as the unified index and scan read it, tagged with its library. */
export type SearchableCard =
  | {
    /** The personal library; the card lives under one tier directory. */
    library: 'personal'
    /** The parsed card. */
    card: Card
    /** The personal-library tier directory. */
    tier: CardTier
    /** Absolute card file path. */
    path: string
    /** File mtime in epoch milliseconds. */
    mtime: number
    /** File size in bytes. */
    size: number
  }
  | {
    /** The team library; team cards have no tiers. */
    library: 'team'
    /** The parsed card. */
    card: Card
    /** Absolute card file path. */
    path: string
    /** File mtime in epoch milliseconds. */
    mtime: number
    /** File size in bytes. */
    size: number
  }

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu

/** CJK/kana runs: FTS5 `unicode61` treats such a run as ONE token, so a substring query never matches; we char-split runs instead. */
const CJK_RUN_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g

/**
 * Char-split every CJK/kana run in `text` (each character becomes its own
 * token), leaving other content untouched. A query token like `告警` then
 * becomes the phrase `"告 警"`, which matches adjacent characters in the
 * indexed text — substring search without a segmentation dictionary.
 */
function segmentCjk(text: string): string {
  return text.replace(CJK_RUN_PATTERN, run => Array.from(run).join(' '))
}

/** Tokenize a query into the characters FTS5 `unicode61` treats as token characters. */
function tokenize(query: string): string[] {
  return query.match(TOKEN_PATTERN) ?? []
}

/** Score one card under scan mode: token hits on title (×3), 适用条件 (×2), 标签 (×2), conclusion and lists (×1). */
function scanScore(card: CardFileInfo['card'], tokens: readonly string[]): number {
  const haystacks: readonly [string, number][] = [
    [card.title, 3],
    [card.适用条件, 2],
    [card.标签.join(' '), 2],
    [card.核心结论, 1],
    [card.应做.join(' '), 1],
    [card.不应做.join(' '), 1],
    ...card.反例 === undefined ? [] : [[card.反例, 1]] as [string, number][],
  ]
  let score = 0
  for (const token of tokens) {
    for (const [text, weight] of haystacks) {
      if (text.toLowerCase().includes(token)) score += weight
    }
  }
  return score
}

/** Apply the structured field filters to one card; the tier filter cannot apply to team cards and excludes them. */
function passesFilters(entry: SearchableCard, request: SearchRequest): boolean {
  if (request.type !== undefined && entry.card.type !== request.type) return false
  if (request.status !== undefined && entry.card.状态 !== request.status) return false
  if (request.tier !== undefined && (entry.library !== 'personal' || entry.tier !== request.tier)) return false
  if (request.tags !== undefined && !request.tags.every(tag => entry.card.标签.includes(tag))) return false
  return true
}

function toHit(entry: SearchableCard, score: number): SearchHit {
  return {
    id: entry.card.id,
    title: entry.card.title,
    type: entry.card.type,
    status: entry.card.状态,
    library: entry.library,
    tier: entry.library === 'team' ? 'team' : entry.tier,
    path: entry.path,
    适用条件: entry.card.适用条件,
    标签: entry.card.标签,
    score,
  }
}

/**
 * The deterministic degradation path: filter every card file and rank by
 * token-overlap score, without any index.
 * @param entries - the parsed library.
 * @param request - the retrieval request (limit applied by the caller).
 * @returns the matching hits sorted by score descending, id ascending.
 */
export function scanSearch(entries: readonly SearchableCard[], request: SearchRequest): SearchHit[] {
  const tokens = tokenize(request.query)
  const hits: SearchHit[] = []
  for (const entry of entries) {
    if (!passesFilters(entry, request)) continue
    const score = scanScore(entry.card, tokens)
    if (score > 0) hits.push(toHit(entry, score))
  }
  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return hits
}

/* jscpd:ignore-start -- the owner-only index-database creation pattern is shared with the session-query backends */
/** Exclusively create a missing database file with owner-only permissions. */
async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}
/* jscpd:ignore-end */

/**
 * Open and initialize a card index database, refusing databases that belong
 * to another application and resetting incompatible schema versions in place.
 * @param path - dedicated index path or `:memory:`; missing filesystem paths are created owner-only.
 * @returns an open database with the current schema.
 */
export async function openCardIndex(path: string): Promise<DatabaseSync> {
  /* jscpd:ignore-start -- the owner-only open/validate/reset pattern mirrors the session-query backends */
  const actual = path === ':memory:' ? path : resolve(path)
  if (actual !== ':memory:') {
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
    await createDatabaseFile(actual)
  }
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(actual)
  try {
    const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (applicationId !== 0 && applicationId !== KB_SEARCH_APPLICATION_ID) {
      throw new Error(`kb-search database at "${actual}" belongs to another application`)
    }
    if (applicationId === KB_SEARCH_APPLICATION_ID && version !== KB_SEARCH_SCHEMA_VERSION) {
      db.exec('DROP TABLE IF EXISTS cards; DROP TABLE IF EXISTS cards_fts;')
    }
    db.exec(`PRAGMA application_id = ${KB_SEARCH_APPLICATION_ID}`)
    db.exec(`PRAGMA user_version = ${KB_SEARCH_SCHEMA_VERSION}`)
    /* jscpd:ignore-end */
    db.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        library TEXT NOT NULL,
        id TEXT NOT NULL,
        tier TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        applies_to TEXT NOT NULL,
        tags TEXT NOT NULL,
        path TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (library, id)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
        library UNINDEXED,
        id UNINDEXED,
        title,
        applies_to,
        conclusion,
        should_do,
        should_not_do,
        body,
        tokenize = 'unicode61'
      );
    `)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

/**
 * The FTS5 read model over both libraries: a structured `cards` table plus a
 * `cards_fts` virtual table, keyed by `(library, id)`. `sync` diffs by key +
 * mtime + size so unchanged cards are not rewritten; `search` AND-joins quoted
 * query tokens so malformed FTS5 syntax cannot fail a query.
 */
export class CardIndex {
  /**
   * @param db - an initialized index database (see {@link openCardIndex}).
   */
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Bring the index in line with the parsed library: upsert changed cards,
   * skip unchanged ones, and drop rows whose files vanished.
   * @param entries - the parsed library.
   */
  sync(entries: readonly SearchableCard[]): void {
    const existing = new Map<string, { mtime: number; size: number }>()
    for (const row of this.db.prepare('SELECT library, id, mtime, size FROM cards').all() as { library: string; id: string; mtime: number; size: number }[]) {
      existing.set(`${row.library}:${row.id}`, { mtime: row.mtime, size: row.size })
    }
    const upsert = this.db.prepare(`
      INSERT INTO cards (library, id, tier, type, status, title, applies_to, tags, path, mtime, size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(library, id) DO UPDATE SET
        tier = excluded.tier, type = excluded.type, status = excluded.status,
        title = excluded.title, applies_to = excluded.applies_to, tags = excluded.tags,
        path = excluded.path, mtime = excluded.mtime, size = excluded.size
    `)
    const deleteFts = this.db.prepare('DELETE FROM cards_fts WHERE library = ? AND id = ?')
    const insertFts = this.db.prepare(`
      INSERT INTO cards_fts (library, id, title, applies_to, conclusion, should_do, should_not_do, body)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const seen = new Set<string>()
    for (const entry of entries) {
      const key = `${entry.library}:${entry.card.id}`
      seen.add(key)
      const prior = existing.get(key)
      if (prior !== undefined && prior.mtime === entry.mtime && prior.size === entry.size) continue
      upsert.run(
        entry.library, entry.card.id, entry.library === 'team' ? 'team' : entry.tier,
        entry.card.type, entry.card.状态, entry.card.title,
        entry.card.适用条件, JSON.stringify(entry.card.标签), entry.path, entry.mtime, entry.size,
      )
      deleteFts.run(entry.library, entry.card.id)
      insertFts.run(
        entry.library, entry.card.id, segmentCjk(entry.card.title), segmentCjk(entry.card.适用条件),
        segmentCjk(entry.card.核心结论), segmentCjk(entry.card.应做.join('\n')),
        segmentCjk(entry.card.不应做.join('\n')), segmentCjk(entry.card.反例 ?? ''),
      )
    }
    for (const key of existing.keys()) {
      if (seen.has(key)) continue
      const separator = key.indexOf(':')
      const library = key.slice(0, separator)
      const id = key.slice(separator + 1)
      this.db.prepare('DELETE FROM cards WHERE library = ? AND id = ?').run(library, id)
      deleteFts.run(library, id)
    }
  }

  /**
   * Search the index with BM25 ranking and structured field filters.
   * @param request - the retrieval request.
   * @returns the limited hits and the total match count before the limit.
   */
  search(request: SearchRequest): { hits: SearchHit[]; total: number } {
    const tokens = tokenize(request.query)
    if (tokens.length === 0) return { hits: [], total: 0 }
    const where = ['cards_fts MATCH ?']
    const params: (string | number)[] = [tokens.map(token => `"${segmentCjk(token).trim()}"`).join(' AND ')]
    if (request.type !== undefined) { where.push('cards.type = ?'); params.push(request.type) }
    if (request.status !== undefined) { where.push('cards.status = ?'); params.push(request.status) }
    if (request.tier !== undefined) { where.push('cards.tier = ?'); params.push(request.tier) }
    for (const tag of request.tags ?? []) {
      where.push('EXISTS (SELECT 1 FROM json_each(cards.tags) WHERE json_each.value = ?)')
      params.push(tag)
    }
    const rows = this.db.prepare(`
      SELECT cards.library, cards.id, cards.tier, cards.type, cards.status, cards.title,
             cards.applies_to, cards.tags, cards.path, -bm25(cards_fts) AS score
      FROM cards_fts JOIN cards ON cards.library = cards_fts.library AND cards.id = cards_fts.id
      WHERE ${where.join(' AND ')}
      ORDER BY score DESC, cards.library ASC, cards.id ASC
      LIMIT ?
    `).all(...params, request.limit) as Array<{
      library: CardLibrary
      id: string
      tier: CardTier | 'team'
      type: CardType
      status: CardStatus
      title: string
      applies_to: string
      tags: string
      path: string
      score: number
    }>
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS total FROM cards_fts JOIN cards ON cards.library = cards_fts.library AND cards.id = cards_fts.id
      WHERE ${where.join(' AND ')}
    `).get(...params) as { total: number }
    return {
      hits: rows.map(row => ({
        id: row.id as CardId,
        title: row.title,
        type: row.type,
        status: row.status,
        library: row.library,
        tier: row.tier,
        path: row.path,
        适用条件: row.applies_to,
        标签: JSON.parse(row.tags) as string[],
        score: row.score,
      })),
      total: totalRow.total,
    }
  }

  /** Close the underlying database. */
  close(): void {
    this.db.close()
  }
}
