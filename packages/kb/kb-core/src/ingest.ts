/**
 * Incremental ingest minimal implementation (production mode E): import
 * card-shaped `*.md` files from a source directory into the personal library
 * as draft cards, wrap raw markdown notes (no front matter) into draft cards
 * with deterministic field inference, and skip unwrappable files with a
 * checkpoint file (mtime + size) and dedup by card id. Non-markdown files are
 * skipped and counted each run. Scheduling through `ctx.jobs` arrives with a
 * real connector.
 * @module @deepseek-ai/dsh-kb-core/ingest
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { parseCard } from './card.ts'
import { compactDateKey, dateStringInDays } from './date.ts'
import type { PersonalCardStore } from './store.ts'
import type { Card, CardId, CardTier, CardType } from './types.ts'

/** Checkpoint file name inside the library root. */
const INGEST_STATE_FILE = '.ingest-state.json'

/** The card type raw notes wrap into: the generic operational-document default. */
const WRAP_TYPE: CardType = 'howto'
/** The fixed 责任人 marker on wrapped cards (the importing entity is unknown). */
const WRAP_OWNER = '导入'
/** Cap on a wrapped card's 核心结论 in characters. */
const WRAP_CONCLUSION_MAX_CHARS = 1000
/** Cap on a wrapped card's 适用条件 in characters. */
const WRAP_CONDITION_MAX_CHARS = 200
/** The default 有效期 horizon in days when `ImportOptions.cardTtlDays` is absent. */
const DEFAULT_CARD_TTL_DAYS = 90

/** One checkpoint entry: the imported card id (undefined for skipped raw files) plus file identity. */
interface IngestStateEntry {
  cardId?: CardId
  mtime: number
  size: number
}

/** Import options. */
export interface ImportOptions {
  /** The session workspace root. */
  root: string
  /** Absolute source directory to scan recursively. */
  sourceDir: string
  /** Target tier for imported cards (draft cards land in P2). */
  tier: CardTier
  /** Days added to today for a wrapped card's 有效期 (default 90). */
  cardTtlDays?: number
}

/** Import outcome. */
export interface IngestResult {
  /** Ids of cards written by this run. */
  imported: CardId[]
  /** Files skipped because the checkpoint matched (already imported, unchanged). */
  skipped: number
  /** Files skipped because they cannot be imported or wrapped (malformed cards, empty notes, non-markdown files). */
  skippedRaw: number
}

/** Read the checkpoint map; a corrupt checkpoint fails loud rather than silently re-importing everything. */
async function readState(path: string): Promise<Map<string, IngestStateEntry>> {
  try {
    const text = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not a mapping')
    }
    const entries = new Map<string, IngestStateEntry>()
    for (const [sourcePath, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof raw !== 'object' || raw === null) {
        throw new Error(`entry for ${sourcePath} is malformed`)
      }
      const record = raw as Record<string, unknown>
      if (typeof record['mtime'] !== 'number' || typeof record['size'] !== 'number') {
        throw new Error(`entry for ${sourcePath} is malformed`)
      }
      const cardId = record['cardId']
      if (cardId !== undefined && typeof cardId !== 'string') {
        throw new Error(`entry for ${sourcePath} has a malformed cardId`)
      }
      entries.set(sourcePath, { ...cardId === undefined ? {} : { cardId: cardId as CardId }, mtime: record['mtime'], size: record['size'] })
    }
    return entries
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    // readFile and JSON.parse only throw Error instances.
    throw new Error(`kb ingest checkpoint at "${path}" is corrupt: ${(error as Error).message}`)
  }
}

/** Recursively list every file under a directory, split into markdown and other files. */
async function walkFiles(dir: string): Promise<{ markdown: string[]; other: string[] }> {
  const markdown: string[] = []
  const other: string[] = []
  const walk = async (current: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
      } else if (entry.isFile()) {
        (entry.name.endsWith('.md') ? markdown : other).push(path)
      }
    }
  }
  await walk(dir)
  return { markdown, other }
}

/** Whether the file text opens with a YAML front-matter fence (an attempted card). */
function isFrontMatterFile(text: string): boolean {
  return text.split(/\r?\n/)[0] === '---'
}

/**
 * Infer the wrapped card's content fields from a raw note: `title` from the
 * first heading (falling back to the file basename), `适用条件` from the first
 * non-heading line, `核心结论` from the non-heading body (headings dropped so
 * the serialized card never carries a `## `-leading line that breaks
 * re-parsing), and one tag from the parent directory relative to the source
 * dir when the file is nested.
 * @param text - the raw note text.
 * @param path - the source file path.
 * @param sourceDir - the import source directory.
 * @returns the inferred fields, or undefined when the note has no content.
 */
function inferRawNote(
  text: string,
  path: string,
  sourceDir: string,
): { title: string; condition: string; conclusion: string; tags: string[] } | undefined {
  const lines = text.split(/\r?\n/)
  const headingPattern = /^#{1,6}\s+/
  const content = lines
    .filter(line => !headingPattern.test(line))
    .map(line => line.trim())
    .filter(line => line !== '')
  if (content.length === 0) return undefined
  const heading = lines.find(line => headingPattern.test(line))?.replace(headingPattern, '').trim()
  const relativeDir = dirname(relative(sourceDir, path))
  return {
    title: heading ?? basename(path).replace(/\.md$/i, ''),
    condition: (content[0] as string).slice(0, WRAP_CONDITION_MAX_CHARS),
    conclusion: content.join('\n').slice(0, WRAP_CONCLUSION_MAX_CHARS),
    tags: relativeDir === '.' ? [] : [relativeDir.split(sep)[0] as string],
  }
}

/**
 * Import card-shaped files from a source directory into the personal library.
 * A new card lands as `draft`; raw markdown notes wrap into draft cards with
 * deterministic field inference; re-importing an existing id preserves the
 * card's current status and moves the file to the target tier. Unchanged
 * files are skipped via the checkpoint; non-markdown files are skipped and
 * counted every run.
 * @param store - the target personal library.
 * @param options - import options.
 * @returns the import outcome.
 */
export async function importDir(store: PersonalCardStore, options: ImportOptions): Promise<IngestResult> {
  const statePath = join(store.libraryRoot, INGEST_STATE_FILE)
  const state = await readState(statePath)
  const { markdown, other } = await walkFiles(options.sourceDir)
  const imported: CardId[] = []
  let skipped = 0
  let skippedRaw = other.length
  for (const file of markdown) {
    const info = await stat(file)
    const prior = state.get(file)
    if (prior !== undefined && prior.mtime === info.mtimeMs && prior.size === info.size) {
      if (prior.cardId === undefined) skippedRaw++
      else skipped++
      continue
    }
    const text = await readFile(file, 'utf8')
    let source: Card
    try {
      source = parseCard(text, file)
    } catch {
      // Raw-note path: only files without front matter can wrap; a
      // front-matter file that fails parsing is a malformed card, never
      // wrapped (wrapping would silently destroy its intended structure).
      if (isFrontMatterFile(text)) {
        skippedRaw++
        state.set(file, { mtime: info.mtimeMs, size: info.size })
        continue
      }
      const inferred = inferRawNote(text, file, options.sourceDir)
      if (inferred === undefined) {
        skippedRaw++
        state.set(file, { mtime: info.mtimeMs, size: info.size })
        continue
      }
      const id = prior?.cardId ?? await store.nextId(WRAP_TYPE, compactDateKey())
      const existing = await store.find(id)
      if (existing !== undefined) {
        await store.remove(existing.tier, id)
      }
      const card: Card = {
        id,
        type: WRAP_TYPE,
        title: inferred.title,
        库: 'personal',
        状态: existing?.card.状态 ?? 'draft',
        适用条件: inferred.condition,
        核心结论: inferred.conclusion,
        应做: [],
        不应做: [],
        来源: file,
        责任人: WRAP_OWNER,
        有效期: dateStringInDays(options.cardTtlDays ?? DEFAULT_CARD_TTL_DAYS),
        标签: inferred.tags,
      }
      await store.write(card, options.tier)
      imported.push(id)
      state.set(file, { cardId: id, mtime: info.mtimeMs, size: info.size })
      continue
    }
    const existing = await store.find(source.id)
    if (existing !== undefined) {
      await store.remove(existing.tier, source.id)
    }
    const target: Card = {
      ...source,
      库: 'personal',
      状态: existing?.card.状态 ?? 'draft',
      来源: source.来源 ?? file,
    }
    await store.write(target, options.tier)
    imported.push(source.id)
    state.set(file, { cardId: source.id, mtime: info.mtimeMs, size: info.size })
  }
  const present = new Set(markdown)
  for (const path of state.keys()) {
    if (!present.has(path)) state.delete(path)
  }
  await mkdir(store.libraryRoot, { recursive: true })
  await writeFile(statePath, `${JSON.stringify(Object.fromEntries(state), null, 2)}\n`, 'utf8')
  return { imported, skipped, skippedRaw }
}
