/**
 * The local calendar date as `YYYY-MM-DD` — the shared scan-date face of the
 * freshness and recap renders and their tools.
 * @module @deepseek-ai/dsh-kb-core/date
 */

/**
 * The current local date as `YYYY-MM-DD`.
 * @returns the date string.
 */
export function todayString(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
