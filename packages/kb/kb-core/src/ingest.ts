/**
 * Incremental ingest minimal implementation (production mode E): import
 * card-shaped `*.md` files from a source directory into the personal library
 * as draft cards, with a checkpoint file (mtime + size) and dedup by card id.
 * Raw non-card files are skipped and counted; converting them into cards is
 * the recap/distill milestone's job. Scheduling through `ctx.jobs` arrives
 * with a real connector.
 * @module @deepseek-ai/dsh-kb-core/ingest
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseCard } from './card.ts'
import type { PersonalCardStore } from './store.ts'
import type { Card, CardId, CardTier } from './types.ts'

/** Checkpoint file name inside the library root. */
const INGEST_STATE_FILE = '.ingest-state.json'

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
  /** Absolute source directory to scan recursively for `*.md` files. */
  sourceDir: string
  /** Target tier for imported cards (draft cards land in P2). */
  tier: CardTier
}

/** Import outcome. */
export interface IngestResult {
  /** Ids of cards written by this run. */
  imported: CardId[]
  /** Files skipped because the checkpoint matched (already imported, unchanged). */
  skipped: number
  /** Files skipped because they do not parse as cards (raw notes). */
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

/** Recursively list every `*.md` file under a directory. */
async function walkMarkdown(dir: string): Promise<string[]> {
  const files: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return files
    throw error
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walkMarkdown(path))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(path)
    }
  }
  return files
}

/**
 * Import card-shaped files from a source directory into the personal library.
 * A new card lands as `draft`; re-importing an existing id preserves the
 * card's current status and moves the file to the target tier. Unchanged
 * files are skipped via the checkpoint.
 * @param store - the target personal library.
 * @param options - import options.
 * @returns the import outcome.
 */
export async function importDir(store: PersonalCardStore, options: ImportOptions): Promise<IngestResult> {
  const statePath = join(store.libraryRoot, INGEST_STATE_FILE)
  const state = await readState(statePath)
  const files = await walkMarkdown(options.sourceDir)
  const imported: CardId[] = []
  let skipped = 0
  let skippedRaw = 0
  for (const file of files) {
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
      skippedRaw++
      state.set(file, { mtime: info.mtimeMs, size: info.size })
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
  const present = new Set(files)
  for (const path of state.keys()) {
    if (!present.has(path)) state.delete(path)
  }
  await mkdir(store.libraryRoot, { recursive: true })
  await writeFile(statePath, `${JSON.stringify(Object.fromEntries(state), null, 2)}\n`, 'utf8')
  return { imported, skipped, skippedRaw }
}
