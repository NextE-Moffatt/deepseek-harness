/**
 * The shared JSONL read of the machine-owned derived files (the heat ledger
 * and the recap checkpoint): parse every non-empty line, fail loud on
 * malformed content — a corrupt line in derived data is a bug to surface, not
 * a record to drop — and treat a missing file as an empty projection.
 * @module @deepseek-ai/dsh-kb-core/jsonl
 */

import { readFile } from 'node:fs/promises'

/**
 * Read every JSON line of a JSONL file.
 * @param path - the file path.
 * @returns the parsed values in file order; an empty array when the file does
 *   not exist, and a throw when a line is malformed or the path is not a
 *   readable file.
 */
export async function readJsonLines(path: string): Promise<unknown[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return text.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as unknown)
}
