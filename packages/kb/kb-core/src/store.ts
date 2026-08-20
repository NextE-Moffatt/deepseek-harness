/**
 * Personal-library storage: card files under `<workspace>/<cardsPath>/<tier>/<id>.md`
 * with tiers P0–P3. The card file is the source of truth for the library; the
 * session log carries the model-visible write facts. Parsing failures are
 * reported per file by `list` so a hand-edited library stays readable.
 * @module @deepseek-ai/dsh-kb-core/store
 */

import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CARD_TIERS, parseCard, serializeCard } from './card.ts'
import type { Card, CardId, CardTier } from './types.ts'

/** One parsed card file with the directory tier and filesystem metadata that the index sync needs. */
export interface CardFileInfo {
  /** The parsed card. */
  card: Card
  /** The tier directory the file lives in. */
  tier: CardTier
  /** Absolute path of the card file. */
  path: string
  /** File mtime in epoch milliseconds, for index diffing. */
  mtime: number
  /** File size in bytes, for index diffing. */
  size: number
}

/** A file under the library that failed to parse, reported by `list`. */
export interface CardParseFailure {
  /** Absolute path of the offending file. */
  path: string
  /** The parse error message. */
  message: string
}

/**
 * Filesystem access to one personal library rooted at `<root>/<cardsPath>`.
 * Ids are unique across all four tiers: `write` fails on an existing id, and
 * `find` scans tiers in order.
 */
export class PersonalCardStore {
  /** Absolute path of the library's cards directory. */
  readonly libraryRoot: string

  /**
   * @param root - the session workspace root.
   * @param cardsPath - the library path relative to the root.
   */
  constructor(readonly root: string, cardsPath: string) {
    this.libraryRoot = resolve(root, cardsPath)
  }

  /** Absolute path of one tier directory.
   * @param tier - the tier.
   * @returns the tier directory path.
   */
  tierDir(tier: CardTier): string {
    return join(this.libraryRoot, tier)
  }

  /** Absolute path of one card file.
   * @param tier - the tier directory.
   * @param id - the card id.
   * @returns the card file path.
   */
  cardPath(tier: CardTier, id: CardId): string {
    return join(this.tierDir(tier), `${id}.md`)
  }

  /**
   * List every parseable card file and every parse failure in the library.
   * Non-`.md` files (the ingest checkpoint) are ignored; missing tier
   * directories list as empty.
   * @returns parsed cards with tier/path/stat and per-file parse failures.
   */
  async list(): Promise<{ cards: CardFileInfo[]; failures: CardParseFailure[] }> {
    const cards: CardFileInfo[] = []
    const failures: CardParseFailure[] = []
    for (const tier of CARD_TIERS) {
      let entries
      try {
        entries = await readdir(this.tierDir(tier), { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue
        const path = join(this.tierDir(tier), entry.name)
        /* jscpd:ignore-start -- the sync/async listing twins share the per-file stat/read/parse-failure handling */
        try {
          const info = await stat(path)
          const text = await readFile(path, 'utf8')
          cards.push({ card: parseCard(text, path), tier, path, mtime: info.mtimeMs, size: info.size })
        } catch (error) {
          // stat, readFile, and parseCard only throw Error instances.
          failures.push({ path, message: (error as Error).message })
        }
        /* jscpd:ignore-end */
      }
    }
    return { cards, failures }
  }

  /**
   * Synchronous twin of {@link list}, for the session-start injection listener
   * (a fire-and-forget emit that must complete its read before the first
   * prompt assembly). Same tier walk, same per-file parse-failure reporting.
   * @returns parsed cards with tier/path/stat and per-file parse failures.
   */
  listSync(): { cards: CardFileInfo[]; failures: CardParseFailure[] } {
    const cards: CardFileInfo[] = []
    const failures: CardParseFailure[] = []
    for (const tier of CARD_TIERS) {
      let names: string[]
      try {
        names = readdirSync(this.tierDir(tier))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      for (const name of names) {
        if (!name.endsWith('.md')) continue
        const path = join(this.tierDir(tier), name)
        try {
          const info = statSync(path)
          const text = readFileSync(path, 'utf8')
          cards.push({ card: parseCard(text, path), tier, path, mtime: info.mtimeMs, size: info.size })
        } catch (error) {
          // statSync, readFileSync, and parseCard only throw Error instances.
          failures.push({ path, message: (error as Error).message })
        }
      }
    }
    return { cards, failures }
  }

  /**
   * Find one card by id across all tiers.
   * @param id - the card id.
   * @returns the card file info, or undefined when no tier holds it.
   */
  async find(id: CardId): Promise<CardFileInfo | undefined> {
    for (const tier of CARD_TIERS) {
      const path = this.cardPath(tier, id)
      try {
        const info = await stat(path)
        const text = await readFile(path, 'utf8')
        return { card: parseCard(text, path), tier, path, mtime: info.mtimeMs, size: info.size }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
    }
    return undefined
  }

  /**
   * Write a new card file, failing loud on an existing id.
   * @param card - the card to write.
   * @param tier - the tier directory to write into.
   * @returns the absolute path written.
   */
  async write(card: Card, tier: CardTier): Promise<string> {
    const path = this.cardPath(tier, card.id)
    await mkdir(this.tierDir(tier), { recursive: true })
    const handle = await open(path, 'wx', 0o600).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`card id ${card.id} already exists in tier ${tier}`)
      }
      throw error
    })
    try {
      await handle.writeFile(serializeCard(card), 'utf8')
    } finally {
      await handle.close()
    }
    return path
  }

  /**
   * Overwrite an existing card file (used by lifecycle transitions).
   * @param card - the card with the new state.
   * @param tier - the tier directory holding the card.
   * @returns the absolute path written.
   */
  async rewrite(card: Card, tier: CardTier): Promise<string> {
    const path = this.cardPath(tier, card.id)
    await writeFile(path, serializeCard(card), 'utf8')
    return path
  }

  /**
   * Delete a card file.
   * @param tier - the tier directory holding the card.
   * @param id - the card id.
   */
  async remove(tier: CardTier, id: CardId): Promise<void> {
    await rm(this.cardPath(tier, id), { force: true })
  }

  /**
   * Generate the next id in the design's `{type}-YYYYMMDD-{seq}` format for a
   * given day: the max existing sequence for the prefix plus one, zero-padded
   * to three digits.
   * @param type - the card type (also the id prefix).
   * @param date - the local date key in `YYYYMMDD` form.
   * @returns the next card id.
   */
  async nextId(type: string, date: string): Promise<CardId> {
    const prefix = `${type}-${date}-`
    let max = 0
    for (const { card } of (await this.list()).cards) {
      if (!card.id.startsWith(prefix)) continue
      const sequence = Number(card.id.slice(prefix.length))
      if (Number.isFinite(sequence) && sequence > max) max = sequence
    }
    return `${prefix}${String(max + 1).padStart(3, '0')}` as CardId
  }
}
