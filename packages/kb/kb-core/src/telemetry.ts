/**
 * kb-telemetry: the heat ledger projected from the session log. `kb/injected`
 * events are the one consumption fact — the payload's `cardIds` face exists
 * for exactly this projection — and the ledger is a JSONL append-only log of
 * (card, session, time, pack) tuples, rebuilt from session logs alone. The
 * live listener consumes `session/event` dispatches and appends; the ledger
 * file is the durable projection, never a second source of truth. Heat feeds
 * the freshness recommendations (govern) and future revival/promotion signals.
 * @module @deepseek-ai/dsh-kb-core/telemetry
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { CardId } from './types.ts'
import type { KbService } from './index.ts'

/** One heat ledger entry: one card consumed by one session through one pack. */
export interface HeatEntry {
  /** The consumed card id. */
  cardId: CardId
  /** The consuming session id. */
  sessionId: SessionId
  /** ISO timestamp of the consumption event. */
  at: string
  /** The pack that injected the card. */
  pack: string
}

/** One aggregated heat row: a card's consumption across the ledger. */
export interface HeatRow {
  /** The consumed card id. */
  cardId: CardId
  /** Total consumption count. */
  count: number
  /** ISO timestamp of the most recent consumption. */
  lastAt: string
  /** The distinct consuming session ids, sorted. */
  sessions: string[]
  /** The distinct injecting packs, sorted. */
  packs: string[]
}

/**
 * Project one session log into heat entries: every `kb/injected` event yields
 * one entry per card id. The session log is the fact source — this function is
 * the rebuild path that reproduces the ledger without the live listener.
 * @param sessionId - the session's id.
 * @param events - the session log.
 * @returns the heat entries in log order.
 */
export function projectInjectedHeat(sessionId: SessionId, events: readonly SessionEvent[]): HeatEntry[] {
  const entries: HeatEntry[] = []
  for (const event of events) {
    if (event.type !== 'kb/injected') continue
    const at = new Date(event.time).toISOString()
    for (const cardId of event.data.cardIds) {
      entries.push({ cardId, sessionId, at, pack: event.data.pack })
    }
  }
  return entries
}

/**
 * Aggregate heat entries into per-card rows.
 * @param entries - the ledger entries.
 * @returns the rows, card-id ascending.
 */
export function aggregateHeat(entries: readonly HeatEntry[]): HeatRow[] {
  const rows = new Map<string, HeatRow>()
  for (const entry of entries) {
    let row = rows.get(entry.cardId)
    if (row === undefined) {
      row = { cardId: entry.cardId, count: 0, lastAt: entry.at, sessions: [], packs: [] }
      rows.set(entry.cardId, row)
    }
    row.count += 1
    if (entry.at > row.lastAt) row.lastAt = entry.at
    if (!row.sessions.includes(entry.sessionId)) row.sessions.push(entry.sessionId)
    if (!row.packs.includes(entry.pack)) row.packs.push(entry.pack)
  }
  return [...rows.values()]
    .map(row => ({ ...row, sessions: [...row.sessions].sort(), packs: [...row.packs].sort() }))
    .sort((a, b) => a.cardId.localeCompare(b.cardId))
}

/**
 * The durable heat ledger: an append-only JSONL file at `kb/.kb-heat.jsonl`
 * (config `heatPath`). Append-only by construction — the rebuild path
 * (`writeAll` over projected session logs) replaces the file wholesale.
 */
export class HeatLedger {
  /** Absolute ledger file path. */
  readonly path: string

  /**
   * @param path - the ledger file path (resolved by the caller).
   */
  constructor(path: string) {
    this.path = resolve(path)
  }

  /**
   * Append entries as JSON lines.
   * @param entries - the entries to append.
   */
  async append(entries: readonly HeatEntry[]): Promise<void> {
    if (entries.length === 0) return
    await mkdir(dirname(this.path), { recursive: true })
    const lines = entries.map(entry => JSON.stringify(entry)).join('\n')
    await appendFile(this.path, `${lines}\n`, 'utf8')
  }

  /**
   * Read every entry. Malformed lines fail loud: the ledger is machine-owned
   * derived data, and a corrupt line is a bug to surface, not heat to drop.
   * @returns the entries in file order.
   */
  async readAll(): Promise<HeatEntry[]> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return text.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as HeatEntry)
  }

  /**
   * Replace the ledger with rebuilt entries (the from-session-logs path).
   * @param entries - the rebuilt entries.
   */
  async writeAll(entries: readonly HeatEntry[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const lines = entries.map(entry => JSON.stringify(entry)).join('\n')
    await writeFile(this.path, lines.length === 0 ? '' : `${lines}\n`, 'utf8')
  }
}

/**
 * Register the live telemetry projection: consume `session/event` dispatches
 * and append every `kb/injected` event's card ids to the workspace's ledger.
 * Telemetry is advisory — any failure logs and continues, never breaking the
 * loop; sessions without a workspace skip the projection.
 * @param ctx - registrant context carrying the session event dispatch.
 * @param kb - the kb service holding the heat path config.
 */
export function registerKbTelemetry(ctx: Context, kb: KbService): void {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'kb/injected') return
    const cwd = session.header.cwd
    if (cwd === undefined) return
    const ledger = new HeatLedger(resolve(cwd, kb.config.heatPath))
    void ledger.append(projectInjectedHeat(session.id, [event])).catch((error: unknown) => {
      ctx.logger.debug('dsh-kb-core: heat ledger append failed: %o', error)
    })
  }, { global: true })
}
