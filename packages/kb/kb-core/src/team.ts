/**
 * Team-library storage: card files under `<teamRepo>/cards/<id>.md` plus the
 * document-style wiki under `<teamRepo>/docs/`, in one shared git work tree.
 * The card file is the source of truth; the session log carries the
 * model-visible write facts. Team cards have no personal tiers — the L1–L4
 * team levels are a future schema evolution (see the card-schema-versioning
 * Agent Note). Docs are for humans and never enter the citation pool: the
 * store lists them separately from cards, and injection and freshness consume
 * cards only. Git operations (status/stage/commit) live in `gitops.ts`.
 * @module @deepseek-ai/dsh-kb-core/team
 */

import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parseCard, serializeCard } from './card.ts'
import type { Card, CardId } from './types.ts'

/** One parsed team card file with the filesystem metadata the index sync needs. */
export interface TeamCardFileInfo {
  /** The parsed card. */
  card: Card
  /** Absolute path of the card file. */
  path: string
  /** File mtime in epoch milliseconds. */
  mtime: number
  /** File size in bytes. */
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
 * Filesystem access to one team library: cards under `cards/`, wiki documents
 * under `docs/`. Construction fails loud when the root is not a git work tree
 * (a `.git` entry must exist), so a misconfigured `teamRepoPath` surfaces at
 * the earliest resolvable point.
 */
export class TeamCardStore {
  /**
   * @param repoRoot - the team repository work tree path.
   */
  constructor(readonly repoRoot: string) {
    if (!existsSync(join(repoRoot, '.git'))) {
      throw new Error(`team library at "${repoRoot}" is not a git work tree (missing .git); create it with "git init" first`)
    }
  }

  /** Absolute path of one card file.
   * @param id - the card id.
   * @returns the card file path under `cards/`.
   */
  cardPath(id: CardId): string {
    return join(this.repoRoot, 'cards', `${id}.md`)
  }

  /**
   * List every parseable team card and every parse failure in `cards/`.
   * Non-`.md` files are ignored; a missing `cards/` directory lists as empty.
   * @returns parsed cards with path/stat and per-file parse failures.
   */
  async list(): Promise<{ cards: TeamCardFileInfo[]; failures: CardParseFailure[] }> {
    return this.listFrom(entries => this.parseEntries(entries))
  }

  /**
   * Synchronous twin of {@link list}, for the session-start injection listener.
   * @returns parsed cards with path/stat and per-file parse failures.
   */
  listSync(): { cards: TeamCardFileInfo[]; failures: CardParseFailure[] } {
    return this.listFrom(entries => this.parseEntriesSync(entries))
  }

  /** Shared listing walk: enumerate `cards/*.md`, then run the sync/async parse pass. */
  private listFrom<T>(parse: (names: string[]) => T): T {
    let names: string[]
    try {
      names = readdirSync(join(this.repoRoot, 'cards'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = []
      else throw error
    }
    return parse(names.filter(name => name.endsWith('.md')))
  }

  /* jscpd:ignore-start */
  /** Async per-file stat/read/parse pass with per-file failure reporting. */
  private async parseEntries(names: string[]): Promise<{ cards: TeamCardFileInfo[]; failures: CardParseFailure[] }> {
    const cards: TeamCardFileInfo[] = []
    const failures: CardParseFailure[] = []
    for (const name of names) {
      const path = join(this.repoRoot, 'cards', name)
      try {
        const info = await stat(path)
        const text = await readFile(path, 'utf8')
        cards.push({ card: parseCard(text, path), path, mtime: info.mtimeMs, size: info.size })
      } catch (error) {
        // stat, readFile, and parseCard only throw Error instances.
        failures.push({ path, message: (error as Error).message })
      }
    }
    return { cards, failures }
  }

  /** Synchronous per-file stat/read/parse pass with per-file failure reporting. */
  private parseEntriesSync(names: string[]): { cards: TeamCardFileInfo[]; failures: CardParseFailure[] } {
    const cards: TeamCardFileInfo[] = []
    const failures: CardParseFailure[] = []
    for (const name of names) {
      const path = join(this.repoRoot, 'cards', name)
      try {
        const info = statSync(path)
        const text = readFileSync(path, 'utf8')
        cards.push({ card: parseCard(text, path), path, mtime: info.mtimeMs, size: info.size })
      } catch (error) {
        // statSync, readFileSync, and parseCard only throw Error instances.
        failures.push({ path, message: (error as Error).message })
      }
    }
    return { cards, failures }
  }
  /* jscpd:ignore-end */

  /**
   * Find one card by id.
   * @param id - the card id.
   * @returns the card file info, or undefined when the library does not hold it.
   */
  async find(id: CardId): Promise<TeamCardFileInfo | undefined> {
    const path = this.cardPath(id)
    try {
      const info = await stat(path)
      const text = await readFile(path, 'utf8')
      return { card: parseCard(text, path), path, mtime: info.mtimeMs, size: info.size }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  /**
   * Write a new team card file, failing loud on an existing id — the
   * concurrency boundary for the personal→team move: a same-id race surfaces
   * here instead of overwriting.
   * @param card - the card to write.
   * @returns the absolute path written.
   */
  async write(card: Card): Promise<string> {
    const path = this.cardPath(card.id)
    await mkdir(join(this.repoRoot, 'cards'), { recursive: true })
    const handle = await open(path, 'wx', 0o600).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`card id ${card.id} already exists in the team library`)
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
   * Overwrite an existing team card file (used by lifecycle transitions).
   * @param card - the card with the new state.
   * @returns the absolute path written.
   */
  async rewrite(card: Card): Promise<string> {
    const path = this.cardPath(card.id)
    await writeFile(path, serializeCard(card), 'utf8')
    return path
  }

  /**
   * Delete a team card file.
   * @param id - the card id.
   */
  async remove(id: CardId): Promise<void> {
    await rm(this.cardPath(id), { force: true })
  }

  /**
   * List the wiki documents under `docs/` as repository-relative paths
   * (`docs/...`), recursively, `.md` files only. Docs never enter the card
   * list, the search index, or the citation pool — the design's document-type
   * layer is human reading material.
   * @returns the sorted doc paths relative to the repository root.
   */
  async listDocs(): Promise<string[]> {
    const docs = new Set<string>()
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) await walk(path)
        else if (entry.isFile() && entry.name.endsWith('.md')) docs.add(relative(this.repoRoot, path))
      }
    }
    await walk(join(this.repoRoot, 'docs'))
    return [...docs].sort()
  }

  /**
   * Read one wiki document, refusing paths that escape `docs/`.
   * @param docPath - the repository-relative doc path (`docs/...`).
   * @returns the document text.
   */
  async readDoc(docPath: string): Promise<string> {
    const resolved = this.resolveDocPath(docPath, false)
    return readFile(resolved, 'utf8')
  }

  /**
   * The identity of one wiki document (mtime + size), the optimistic conflict
   * guard's expected values. Fails loud when the doc is missing.
   * @param docPath - the repository-relative doc path (`docs/...`).
   * @returns the file identity.
   */
  async docInfo(docPath: string): Promise<{ mtime: number; size: number }> {
    const info = await stat(this.resolveDocPath(docPath, true))
    return { mtime: info.mtimeMs, size: info.size }
  }

  /**
   * Write (create the parent directory and overwrite) one wiki document. The
   * path must stay inside `docs/` and end in `.md`, so every doc the store
   * writes is listable by {@link listDocs}.
   * @param docPath - the repository-relative doc path (`docs/...`).
   * @param content - the document text.
   * @returns the absolute path written and the file identity after the write.
   */
  async writeDoc(docPath: string, content: string): Promise<{ path: string; mtime: number; size: number }> {
    const resolved = this.resolveDocPath(docPath, true)
    await mkdir(dirname(resolved), { recursive: true })
    await writeFile(resolved, content, 'utf8')
    const info = await stat(resolved)
    return { path: resolved, mtime: info.mtimeMs, size: info.size }
  }

  /**
   * Remove one wiki document, failing loud when it does not exist (a stale
   * delete is an error the caller surfaces, not a silent success).
   * @param docPath - the repository-relative doc path (`docs/...`).
   */
  async removeDoc(docPath: string): Promise<void> {
    const resolved = this.resolveDocPath(docPath, true)
    await rm(resolved, { force: false })
  }

  /**
   * Resolve one repository-relative doc path, refusing paths that escape
   * `docs/` and — for the write operations — paths without a `.md` extension.
   * @param docPath - the repository-relative doc path (`docs/...`).
   * @param requireMarkdown - whether a `.md` extension is required.
   * @returns the absolute path.
   */
  private resolveDocPath(docPath: string, requireMarkdown: boolean): string {
    const resolved = resolve(this.repoRoot, docPath)
    const prefix = `${resolve(this.repoRoot, 'docs')}${sep}`
    if (!resolved.startsWith(prefix)) {
      throw new Error(`doc path must stay inside docs/, got ${JSON.stringify(docPath)}`)
    }
    if (requireMarkdown && !docPath.endsWith('.md')) {
      throw new Error(`doc path must end in .md, got ${JSON.stringify(docPath)}`)
    }
    return resolved
  }
}
