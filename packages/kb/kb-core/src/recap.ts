/**
 * kb-recap: session-log blind-spot scanning, the recap checkpoint, and the
 * `ctx.jobs` scheduler. A blind spot is a workspace session that consumed
 * knowledge (`kb/injected` with card ids) but produced no card (`kb/write`):
 * the flywheel's "use and accumulate" broke exactly there. The scan reads the
 * workspace's session logs (live with precedence over persisted), detects the
 * unrecorded blind spots, lists up to a limit, and records the listed
 * positions into the checkpoint at `KbConfig.recapPath`; the caller (tool or
 * scheduler) appends the `kb/recap` event after the checkpoint write
 * succeeds, and the checkpoint is rebuildable from those events alone
 * (`projectRecapScans` + `RecapCheckpoint.writeAll`). The scheduler is a
 * per-session owner-scoped job started at `agent/session-start` when
 * `KbConfig.recapIntervalDays` is positive; the job runs one scan immediately
 * and then every interval, buffering the rendered list as its output.
 * @module @deepseek-ai/dsh-kb-core/recap
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { todayString } from './date.ts'
import { readJsonLines } from './jsonl.ts'
import { createFreshnessProducer } from './freshness.ts'
import type { KbService } from './index.ts'
import type { CardId, RecapBlindSpot, RecapPosition } from './types.ts'

/** The default per-run listing limit of the recap scan. */
export const DEFAULT_RECAP_LIMIT = 10

/** The per-entry conversation-excerpt cap of a listed blind spot. */
export const RECAP_EXCERPT_MAX_CHARS = 2000

/** The message content block vocabulary of the excerpt renderer. */
type RecapContentBlock = SessionEvent<'user/message'>['data']['content'][number]

/**
 * The text of one content block: text blocks contribute verbatim, tool-call
 * and tool-result blocks contribute nothing (the recap excerpt is the
 * conversation, not the tool traffic), and unknown merged blocks stay out.
 * @param block - a message content block.
 * @returns the block's text contribution.
 */
function excerptBlockText(block: RecapContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'reasoning':
      return ''
    case 'tool-call':
      return ''
    case 'tool-result':
      return ''
    /* v8 ignore start -- RecapContentBlock is merge-extensible; unknown blocks are skipped like session-query's extraction. */
    default:
      return ''
    /* v8 ignore stop */
  }
}

/**
 * The conversation text of one session event: user and assistant messages
 * contribute their content blocks; every other event contributes nothing.
 * @param event - the session event.
 * @returns the event's conversation text (possibly empty).
 */
function messageText(event: SessionEvent): string {
  switch (event.type) {
    case 'user/message':
      return event.data.content.map(excerptBlockText).join('')
    case 'assistant/message':
      return event.data.message.content.map(excerptBlockText).join('')
    default:
      return ''
  }
}

/**
 * Render the bounded conversation excerpt of one session log: the message
 * texts in log order, truncated to the tail when longer than `maxChars` so the
 * most recent discussion — the distillation material — always survives.
 * @param events - the session log.
 * @param maxChars - the excerpt cap (positive).
 * @returns the excerpt, at most `maxChars` characters.
 */
export function renderSessionExcerpt(events: readonly SessionEvent[], maxChars: number): string {
  const joined = events.map(messageText).filter(text => text !== '').join('\n')
  if (joined.length <= maxChars) return joined
  return `…${joined.slice(joined.length - maxChars + 1)}`
}

/**
 * The card ids one session consumed through `kb/injected`, sorted and
 * deduplicated — the consumption face shared with the heat telemetry.
 * @param events - the session log.
 * @returns the consumed card ids, ascending.
 */
export function consumedCardIds(events: readonly SessionEvent[]): CardId[] {
  const ids = new Set<string>()
  for (const event of events) {
    if (event.type !== 'kb/injected') continue
    for (const id of event.data.cardIds) ids.add(id)
  }
  return [...ids].sort() as CardId[]
}

/**
 * Whether a session log consumed knowledge: at least one `kb/injected` event
 * carrying card ids.
 * @param events - the session log.
 * @returns whether the session consumed knowledge.
 */
export function consumedKnowledge(events: readonly SessionEvent[]): boolean {
  return events.some(event => event.type === 'kb/injected' && event.data.cardIds.length > 0)
}

/**
 * Whether a session log produced a card: at least one `kb/write` event.
 * @param events - the session log.
 * @returns whether the session produced a card.
 */
export function producedCard(events: readonly SessionEvent[]): boolean {
  return events.some(event => event.type === 'kb/write')
}

/**
 * Whether a session log is a recap blind spot: it consumed knowledge but
 * produced no card. The predicate is structural — event presence only, never
 * semantics — like the first gate.
 * @param events - the session log.
 * @returns whether the session is a blind spot.
 */
export function isBlindSpot(events: readonly SessionEvent[]): boolean {
  return consumedKnowledge(events) && !producedCard(events)
}

/**
 * The last event time of a session log, the recency sort key.
 * @param events - the session log.
 * @returns the last event time as ISO, or undefined for an empty log.
 */
export function lastEventTime(events: readonly SessionEvent[]): string | undefined {
  const last = events.at(-1)
  return last === undefined ? undefined : new Date(last.time).toISOString()
}

/**
 * Merge checkpoint positions to one per session, keeping the maximum event
 * count, sorted by session id — the recorded-position lookup of a scan.
 * @param positions - the raw checkpoint entries.
 * @returns the merged positions, session-id ascending.
 */
export function mergePositions(positions: readonly RecapPosition[]): RecapPosition[] {
  const merged = new Map<string, number>()
  for (const position of positions) {
    const existing = merged.get(position.sessionId)
    if (existing === undefined || position.eventCount > existing) {
      merged.set(position.sessionId, position.eventCount)
    }
  }
  return [...merged.entries()]
    .map(([sessionId, eventCount]) => ({ sessionId: sessionId as SessionId, eventCount }))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
}

/**
 * Project the recorded positions from one session log: every `kb/recap`
 * event's `scanned` face, merged. The session log is the fact source — this
 * function is the rebuild path that reproduces the checkpoint without the
 * live scan.
 * @param _sessionId - the session's id (the events carry their own positions).
 * @param events - the session log.
 * @returns the merged recorded positions.
 */
export function projectRecapScans(_sessionId: SessionId, events: readonly SessionEvent[]): RecapPosition[] {
  const positions: RecapPosition[] = []
  for (const event of events) {
    if (event.type !== 'kb/recap') continue
    positions.push(...event.data.scanned)
  }
  return mergePositions(positions)
}

/**
 * The durable recap checkpoint: an append-only JSONL file at `kb/.kb-recap.jsonl`
 * (config `recapPath`) holding recorded scan positions. Append-only by
 * construction — the rebuild path (`writeAll` over projected session logs)
 * replaces the file wholesale.
 */
export class RecapCheckpoint {
  /** Absolute checkpoint file path. */
  readonly path: string

  /**
   * @param path - the checkpoint file path (resolved by the caller).
   */
  constructor(path: string) {
    this.path = resolve(path)
  }

  /**
   * Append positions as JSON lines.
   * @param positions - the positions to append.
   */
  async append(positions: readonly RecapPosition[]): Promise<void> {
    if (positions.length === 0) return
    await mkdir(dirname(this.path), { recursive: true })
    const lines = positions.map(position => JSON.stringify(position)).join('\n')
    await appendFile(this.path, `${lines}\n`, 'utf8')
  }

  /**
   * Read every position. Malformed lines fail loud: the checkpoint is
   * machine-owned derived data, and a corrupt line is a bug to surface.
   * @returns the positions in file order.
   */
  async readAll(): Promise<RecapPosition[]> {
    return (await readJsonLines(this.path)) as RecapPosition[]
  }

  /**
   * Replace the checkpoint with rebuilt positions (the from-session-logs path).
   * @param positions - the rebuilt positions.
   */
  async writeAll(positions: readonly RecapPosition[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const lines = positions.map(position => JSON.stringify(position)).join('\n')
    await writeFile(this.path, lines.length === 0 ? '' : `${lines}\n`, 'utf8')
  }
}

/** One workspace session's log as the recap scan reads it. */
export interface RecapSessionLog {
  /** The session id. */
  sessionId: SessionId
  /** The session's event log. */
  events: readonly SessionEvent[]
}

/** The recap scan's session-log source: the workspace's sessions. */
export interface RecapLogSource {
  /**
   * List the workspace's session logs.
   * @param root - the session workspace root.
   * @returns the logs, session-id ascending.
   */
  list(root: string): Promise<RecapSessionLog[]>
}

/**
 * The default log source: live sessions from `ctx.sessions` whose
 * `header.cwd` equals the root, with precedence over persisted sessions from
 * the optional `sessionPersistence` service; a failed persistence read logs
 * and continues with the live side — the scan must never fail the request
 * that asked for it.
 * @param ctx - registrant context carrying the optional services.
 * @returns the default source.
 */
export function liveRecapLogSource(ctx: Context): RecapLogSource {
  const persistence = ctx.get('sessionPersistence')
  return {
    async list(root) {
      const records = new Map<string, RecapSessionLog>()
      const sessions = ctx.get('sessions')
      if (sessions !== undefined) {
        for (const session of sessions.list()) {
          if (session.header.cwd !== root) continue
          records.set(session.id, { sessionId: session.id, events: session.events })
        }
      }
      if (persistence !== undefined) {
        try {
          const headers = await persistence.list()
          for (const header of headers) {
            if (header.cwd !== root || records.has(header.id)) continue
            const inspected = await persistence.inspect(header.id)
            records.set(header.id, { sessionId: header.id, events: inspected.events })
          }
        } catch (error) {
          ctx.logger.warn('dsh-kb-core: persisted session logs unavailable for the recap scan, continuing with live sessions: %o', error)
        }
      }
      return [...records.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    },
  }
}

/** One unrecorded blind spot found by the scan. */
export interface RecapCandidate {
  /** The blind-spot session. */
  sessionId: SessionId
  /** The session's event count at detection; the position recorded on listing. */
  eventCount: number
  /** The session's last event time (ISO), the recency sort key. */
  at: string
  /** The card ids the session consumed, sorted. */
  consumed: CardId[]
  /** The bounded conversation excerpt, the distillation material. */
  excerpt: string
}

/**
 * Detect the unrecorded blind spots: sessions that consumed knowledge but
 * produced no card, whose position is not recorded at or beyond the current
 * log length. Recorded blind spots re-enter only when their session grows.
 * @param logs - the workspace's session logs.
 * @param recorded - the checkpoint positions (merged).
 * @param maxExcerptChars - the per-entry excerpt cap.
 * @returns the candidates, most recent first (session id ascending as tiebreak).
 */
export function detectBlindSpots(
  logs: readonly RecapSessionLog[],
  recorded: readonly RecapPosition[],
  maxExcerptChars: number = RECAP_EXCERPT_MAX_CHARS,
): RecapCandidate[] {
  const positions = new Map(mergePositions(recorded).map(position => [position.sessionId, position.eventCount]))
  const candidates: RecapCandidate[] = []
  for (const log of logs) {
    if (!isBlindSpot(log.events)) continue
    const recordedAt = positions.get(log.sessionId)
    if (recordedAt !== undefined && recordedAt >= log.events.length) continue
    candidates.push({
      sessionId: log.sessionId,
      eventCount: log.events.length,
      /* v8 ignore next -- a blind spot always has events (it consumed knowledge); the fallback guards a future predicate change */
      at: lastEventTime(log.events) ?? '',
      consumed: consumedCardIds(log.events),
      excerpt: renderSessionExcerpt(log.events, maxExcerptChars),
    })
  }
  return candidates.sort((a, b) => b.at.localeCompare(a.at) || a.sessionId.localeCompare(b.sessionId))
}

/** One blind spot listed by the scan with its excerpt. */
export interface BlindSpotEntry {
  /** The blind-spot session. */
  sessionId: SessionId
  /** The session's last event time (ISO). */
  at: string
  /** The card ids the session consumed, sorted. */
  consumed: CardId[]
  /** The bounded conversation excerpt, the distillation material. */
  excerpt: string
}

/** The outcome of one recap scan: the listed blind spots and the recorded positions. */
export interface RecapScanResult {
  /** The scan date `YYYY-MM-DD`. */
  scanDate: string
  /** All unrecorded blind spots found before the limit. */
  total: number
  /** The listed blind spots. */
  entries: BlindSpotEntry[]
  /** The positions recorded into the checkpoint by this scan. */
  recorded: RecapPosition[]
}

/**
 * Run one recap scan for one workspace: read the session logs, detect the
 * unrecorded blind spots, list up to `limit`, and record the listed positions
 * into the checkpoint. The caller (tool or scheduler) appends the `kb/recap`
 * event after the checkpoint write succeeds — the checkpoint is the durable
 * projection, the event the logged fact.
 * @param ctx - registrant context, for diagnostics and the default log source.
 * @param kb - the kb service holding the recap config.
 * @param root - the session workspace root.
 * @param limit - the listing cap (a positive integer).
 * @param source - the session-log source (defaults to live + persisted).
 * @returns the scan outcome.
 */
export async function runRecapScan(
  ctx: Context,
  kb: KbService,
  root: string,
  limit: number,
  source: RecapLogSource = liveRecapLogSource(ctx),
): Promise<RecapScanResult> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(`recap limit must be a positive integer, got ${JSON.stringify(limit)}`)
  }
  const checkpoint = new RecapCheckpoint(resolve(root, kb.config.recapPath))
  const logs = await source.list(root)
  const candidates = detectBlindSpots(logs, await checkpoint.readAll())
  const listed = candidates.slice(0, limit)
  const entries: BlindSpotEntry[] = listed.map(candidate => ({
    sessionId: candidate.sessionId,
    at: candidate.at,
    consumed: candidate.consumed,
    excerpt: candidate.excerpt,
  }))
  const recorded: RecapPosition[] = listed.map(candidate => ({
    sessionId: candidate.sessionId,
    eventCount: candidate.eventCount,
  }))
  await checkpoint.append(recorded)
  return { scanDate: todayString(), total: candidates.length, entries, recorded }
}

/**
 * Render the recap scan list as the model- and human-facing text.
 * @param scanDate - the scan date `YYYY-MM-DD`.
 * @param total - the unrecorded blind spots found.
 * @param entries - the listed blind spots.
 * @returns the rendered list, one block per listed blind spot.
 */
export function renderRecapList(scanDate: string, total: number, entries: readonly BlindSpotEntry[]): string {
  const lines = [`知识复盘扫描（${scanDate}）：发现 ${total} 个盲点${entries.length === total ? '' : `，列出 ${entries.length} 个`}`]
  for (const entry of entries) {
    /* v8 ignore next -- a blind spot always consumed card ids; the fallback guards a future predicate change */
    lines.push(`- [${entry.sessionId}]（${entry.at}）消费：${entry.consumed.join('、') || '无'}`)
    if (entry.excerpt !== '') lines.push(`  会话摘录：${entry.excerpt}`)
  }
  return lines.join('\n')
}

/**
 * The `kb/recap` event payload of one scan result: the recorded positions and
 * the listed blind spots' facts (excerpts stay derived from the referenced
 * sessions' own logs, never duplicated into the event).
 * @param result - the scan outcome.
 * @returns the event payload.
 */
export function recapEventPayload(result: RecapScanResult): {
  scanDate: string
  scanned: RecapPosition[]
  blindSpots: RecapBlindSpot[]
  total: number
  listed: number
} {
  return {
    scanDate: result.scanDate,
    scanned: result.recorded,
    blindSpots: result.entries.map(entry => ({
      sessionId: entry.sessionId,
      at: entry.at,
      consumed: entry.consumed,
    })),
    total: result.total,
    listed: result.entries.length,
  }
}

/** The recap job's producer — the freshness producer's shape, driven by the recap scan. */
export const createRecapProducer = createFreshnessProducer

/** Contexts that already logged the "scheduling unavailable" error. */
const warnedContexts = new WeakSet<object>()

/** Sessions that already own a recap job; jobs are per-session, like injection. */
const scheduledSessions = new WeakSet<object>()

/**
 * Run one recap scan and append its `kb/recap` event to the owner session
 * when it recorded positions — the scheduler's tick face, so job-driven
 * checkpoint advances stay logged.
 * @param ctx - registrant context.
 * @param kb - the kb service holding the recap config.
 * @param root - the session workspace root.
 * @param agent - the job's owner agent.
 * @returns the rendered blind-spot list.
 */
async function recapReviewText(ctx: Context, kb: KbService, root: string, agent: { session: Session }): Promise<string> {
  const result = await runRecapScan(ctx, kb, root, DEFAULT_RECAP_LIMIT)
  if (result.recorded.length > 0) {
    agent.session.append('kb/recap', recapEventPayload(result))
  }
  return renderRecapList(result.scanDate, result.total, result.entries)
}

/**
 * Register the recap scheduler: at `agent/session-start`, start one
 * owner-scoped `kb-recap` job per session (the log-free guard is a per-session
 * object set) when the interval is configured. A configured interval without
 * a jobs service logs one loud error per context and skips scheduling — the
 * earliest resolvable point, never silent.
 * @param ctx - registrant context carrying the agent bus and jobs service.
 * @param kb - the kb service holding the recap config.
 */
export function registerRecapSchedule(ctx: Context, kb: KbService): void {
  ctx.on('agent/session-start', ({ agent }) => {
    if (kb.config.recapIntervalDays <= 0) return
    const jobs = ctx.get('jobs')
    if (jobs === undefined) {
      if (!warnedContexts.has(ctx)) {
        warnedContexts.add(ctx)
        ctx.logger.error('dsh-kb-core: recapIntervalDays is configured but no jobs service is mounted; recap scheduling is unavailable (mount @deepseek-ai/dsh-jobs-local)')
      }
      return
    }
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return
    if (scheduledSessions.has(agent.session)) return
    scheduledSessions.add(agent.session)
    jobs.start({
      kind: 'kb-recap',
      label: `知识复盘扫描（每 ${kb.config.recapIntervalDays} 天）`,
      owner: agent,
      run: () => createRecapProducer(
        () => recapReviewText(ctx, kb, cwd, agent),
        kb.config.recapIntervalDays,
      ),
    })
  })
}

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'kb-recap': 'kb-recap'
  }
}
