/**
 * Local calendar-date helpers shared across the kb modules: the `YYYY-MM-DD`
 * scan-date face of the freshness and recap renders and their tools, the
 * `YYYY-MM-DD` 有效期 default horizon, and the `YYYYMMDD` id-sequence key.
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

/**
 * The date `days` from today as `YYYY-MM-DD`, the 有效期 default.
 * @param days - days to add (may be negative).
 * @returns the date string.
 */
export function dateStringInDays(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * The given date as `YYYYMMDD`, the id-sequence key.
 * @param date - the date (defaults to now).
 * @returns the compact date key.
 */
export function compactDateKey(date: Date = new Date()): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
}
