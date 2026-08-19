// kb-recap coverage: the pure blind-spot predicates and excerpt renderer, the
// checkpoint's append/read/rebuild lifecycle, the default live+persisted log
// source, the scan orchestration with checkpoint dedup and pagination, the
// render and event payload, and the session-start scheduler registration
// (interval off, jobs missing, no cwd, per-session once-only, owner-scoped
// start, and the kb/recap event append on a job tick).
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { KbService, ResolvedKbConfig } from '../src/index.ts'
import {
  RecapCheckpoint, consumedCardIds, consumedKnowledge, detectBlindSpots,
  isBlindSpot, lastEventTime, liveRecapLogSource, mergePositions, producedCard,
  projectRecapScans, recapEventPayload, registerRecapSchedule, renderRecapList,
  renderSessionExcerpt, runRecapScan,
  type BlindSpotEntry, type RecapLogSource, type RecapScanResult, type RecapSessionLog,
} from '../src/recap.ts'
import type { CardId } from '../src/types.ts'

let roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
})

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots = []
})

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

/** A minimal session event of the requested type. */
function event(type: SessionEvent['type'], data: Record<string, unknown>, time = 1_700_000_000_000): SessionEvent {
  return { type, data, seq: 1, time } as SessionEvent
}

/** A `kb/injected` event consuming the given card ids. */
function injected(ids: readonly string[], time = 1_700_000_000_000): SessionEvent {
  return event('kb/injected', {
    pack: '测试包',
    cardIds: ids,
    sections: ids.map(name => ({ name, text: '内容' })),
  }, time)
}

/** A user or assistant message event with one text block. */
function message(type: 'user/message' | 'assistant/message', text: string, time = 1_700_000_000_000): SessionEvent {
  if (type === 'user/message') return event('user/message', { content: [{ type: 'text', text }] }, time)
  return event('assistant/message', { message: { content: [{ type: 'text', text }] } }, time)
}

/** A minimal kb service face for the scan and scheduler. */
function kbLike(config: Partial<ResolvedKbConfig> = {}): {
  config: ResolvedKbConfig
  ctx: { logger: { debug: () => void; warn: () => void; error: () => void } }
} {
  const base: ResolvedKbConfig = {
    cardsPath: 'kb/cards',
    indexPath: 'kb/.kb-index.sqlite',
    cardTtlDays: 90,
    heatPath: 'kb/.kb-heat.jsonl',
    freshnessWarningDays: 14,
    freshnessIntervalDays: 0,
    teamWriteApproval: true,
    recapPath: 'kb/.kb-recap.jsonl',
    recapIntervalDays: 0,
    packs: [],
    ...config,
  }
  return {
    config: base,
    ctx: { logger: { debug: () => {}, warn: () => {}, error: () => {} } },
  }
}

/** An in-memory log source for the scan. */
function logSource(logs: RecapSessionLog[]): RecapLogSource {
  return { list: async () => logs }
}

const CARD = 'rule-20260818-001' as CardId

describe('blind-spot predicates', () => {
  it('consumedCardIds dedupes and sorts the injected card ids', () => {
    const events = [injected(['b', 'a', 'b']), injected(['c']), event('kb/write', { id: 'x' })]
    expect(consumedCardIds(events)).toEqual(['a', 'b', 'c'])
    expect(consumedCardIds([])).toEqual([])
  })

  it('consumedKnowledge and producedCard read the log faces', () => {
    expect(consumedKnowledge([injected(['a'])])).toBe(true)
    expect(consumedKnowledge([injected([])])).toBe(false)
    expect(consumedKnowledge([event('user/message', { content: [] })])).toBe(false)
    expect(producedCard([event('kb/write', { id: 'x' })])).toBe(true)
    expect(producedCard([injected(['a'])])).toBe(false)
  })

  it('isBlindSpot requires consumption without production', () => {
    expect(isBlindSpot([injected(['a'])])).toBe(true)
    expect(isBlindSpot([injected(['a']), event('kb/write', { id: 'x' })])).toBe(false)
    expect(isBlindSpot([event('user/message', { content: [] })])).toBe(false)
    expect(isBlindSpot([])).toBe(false)
  })

  it('lastEventTime returns the ISO time of the last event', () => {
    expect(lastEventTime([injected(['a'], 1_700_000_000_000)])).toBe(new Date(1_700_000_000_000).toISOString())
    expect(lastEventTime([])).toBeUndefined()
  })
})

describe('renderSessionExcerpt', () => {
  it('joins user and assistant message texts in log order', () => {
    const events = [
      message('user/message', '遇到新告警'),
      message('assistant/message', '先确认影响面'),
      event('tool/call', { name: 'kb_search', arguments: '{}' }),
    ]
    expect(renderSessionExcerpt(events, 100)).toBe('遇到新告警\n先确认影响面')
  })

  it('ignores non-message events and unknown content blocks', () => {
    const events = [
      event('request/header', { header: {} }),
      message('user/message', '你好'),
      event('user/message', { content: [{ type: 'tool-call', name: 'kb_search', arguments: '{}' }] }),
      event('user/message', { content: [{ type: 'tool-result', content: [{ type: 'text', text: '结果' }] }] }),
      event('user/message', { content: [{ type: 'reasoning', content: '思考' }] }),
    ]
    expect(renderSessionExcerpt(events, 100)).toBe('你好')
  })

  it('keeps the tail when the conversation exceeds the cap', () => {
    const events = [message('user/message', '一二三四五'), message('assistant/message', '六七八九十')]
    const excerpt = renderSessionExcerpt(events, 6)
    expect(excerpt).toHaveLength(6)
    expect(excerpt.endsWith('七八九十')).toBe(true)
  })

  it('returns an empty excerpt for a log without messages', () => {
    expect(renderSessionExcerpt([injected(['a'])], 100)).toBe('')
  })
})

describe('mergePositions and projectRecapScans', () => {
  it('merges to one position per session keeping the maximum count', () => {
    const positions = [
      { sessionId: SessionId('b'), eventCount: 5 },
      { sessionId: SessionId('a'), eventCount: 3 },
      { sessionId: SessionId('b'), eventCount: 2 },
    ]
    expect(mergePositions(positions)).toEqual([
      { sessionId: SessionId('a'), eventCount: 3 },
      { sessionId: SessionId('b'), eventCount: 5 },
    ])
  })

  it('projects positions from kb/recap events and merges them', () => {
    const events = [
      event('kb/recap', {
        scanDate: '2026-08-19',
        scanned: [{ sessionId: SessionId('b'), eventCount: 2 }],
        blindSpots: [],
        total: 0,
        listed: 0,
      }),
      event('kb/recap', {
        scanDate: '2026-08-19',
        scanned: [{ sessionId: SessionId('a'), eventCount: 4 }, { sessionId: SessionId('b'), eventCount: 3 }],
        blindSpots: [],
        total: 0,
        listed: 0,
      }),
      event('kb/write', { id: 'x' }),
    ]
    expect(projectRecapScans(SessionId('owner'), events)).toEqual([
      { sessionId: SessionId('a'), eventCount: 4 },
      { sessionId: SessionId('b'), eventCount: 3 },
    ])
  })
})

describe('RecapCheckpoint', () => {
  it('appends, reads, and rebuilds the JSONL checkpoint', async () => {
    const root = await tempDir('dsh-kb-recap-checkpoint-')
    const path = join(root, 'kb', '.kb-recap.jsonl')
    const checkpoint = new RecapCheckpoint(path)
    expect(await checkpoint.readAll()).toEqual([])
    await checkpoint.append([{ sessionId: SessionId('s1'), eventCount: 3 }])
    await checkpoint.append([{ sessionId: SessionId('s2'), eventCount: 5 }])
    expect(await checkpoint.readAll()).toEqual([
      { sessionId: SessionId('s1'), eventCount: 3 },
      { sessionId: SessionId('s2'), eventCount: 5 },
    ])
    await checkpoint.writeAll([{ sessionId: SessionId('s3'), eventCount: 1 }])
    expect(await checkpoint.readAll()).toEqual([{ sessionId: SessionId('s3'), eventCount: 1 }])
    expect(await readFile(path, 'utf8')).toContain('s3')
  })

  it('appending nothing leaves the file untouched', async () => {
    const root = await tempDir('dsh-kb-recap-append-none-')
    const checkpoint = new RecapCheckpoint(join(root, 'kb', '.kb-recap.jsonl'))
    await checkpoint.append([])
    await expect(readFile(checkpoint.path, 'utf8')).rejects.toThrow()
  })

  it('writeAll with no positions writes an empty file', async () => {
    const root = await tempDir('dsh-kb-recap-rebuild-')
    const checkpoint = new RecapCheckpoint(join(root, 'kb', '.kb-recap.jsonl'))
    await checkpoint.writeAll([])
    expect(await readFile(checkpoint.path, 'utf8')).toBe('')
  })

  it('fails loud on a corrupt line and a non-file path', async () => {
    const root = await tempDir('dsh-kb-recap-corrupt-')
    await mkdir(join(root, 'kb'), { recursive: true })
    const path = join(root, 'kb', '.kb-recap.jsonl')
    await (await import('node:fs/promises')).writeFile(path, 'not json\n', 'utf8')
    const checkpoint = new RecapCheckpoint(path)
    await expect(checkpoint.readAll()).rejects.toThrow()
    // A directory is not a readable checkpoint file.
    const directory = new RecapCheckpoint(join(root, 'kb'))
    await expect(directory.readAll()).rejects.toThrow()
  })
})

describe('detectBlindSpots', () => {
  it('detects unrecorded blind spots sorted most recent first', () => {
    const logs: RecapSessionLog[] = [
      { sessionId: SessionId('old'), events: [injected(['a'], 1_700_000_000_001)] },
      { sessionId: SessionId('new'), events: [injected(['b'], 1_700_000_000_009)] },
    ]
    const candidates = detectBlindSpots(logs, [])
    expect(candidates.map(candidate => candidate.sessionId)).toEqual([SessionId('new'), SessionId('old')])
    expect(candidates[0]!.consumed).toEqual(['b' as CardId])
    expect(candidates[0]!.eventCount).toBe(1)
  })

  it('breaks recency ties by session id ascending', () => {
    const logs: RecapSessionLog[] = [
      { sessionId: SessionId('b-session'), events: [injected(['a'], 1_700_000_000_001)] },
      { sessionId: SessionId('a-session'), events: [injected(['b'], 1_700_000_000_001)] },
    ]
    const candidates = detectBlindSpots(logs, [])
    expect(candidates.map(candidate => candidate.sessionId)).toEqual([SessionId('a-session'), SessionId('b-session')])
  })

  it('skips healthy sessions and recorded blind spots', () => {
    const logs: RecapSessionLog[] = [
      { sessionId: SessionId('healthy'), events: [injected(['a']), event('kb/write', { id: 'x' })] },
      { sessionId: SessionId('recorded'), events: [injected(['b'], 1_700_000_000_002)] },
      { sessionId: SessionId('fresh'), events: [injected(['c'], 1_700_000_000_003)] },
    ]
    const candidates = detectBlindSpots(logs, [{ sessionId: SessionId('recorded'), eventCount: 1 }])
    expect(candidates.map(candidate => candidate.sessionId)).toEqual([SessionId('fresh')])
  })

  it('re-lists a blind spot whose session grew past the recorded position', () => {
    const logs: RecapSessionLog[] = [
      { sessionId: SessionId('grew'), events: [injected(['a'], 1_700_000_000_001), message('user/message', '新讨论', 1_700_000_000_009)] },
    ]
    const candidates = detectBlindSpots(logs, [{ sessionId: SessionId('grew'), eventCount: 1 }])
    expect(candidates.map(candidate => candidate.sessionId)).toEqual([SessionId('grew')])
    expect(candidates[0]!.excerpt).toContain('新讨论')
  })

  it('caps the excerpt at the given bound', () => {
    const logs: RecapSessionLog[] = [
      { sessionId: SessionId('long'), events: [injected(['a']), message('user/message', '一二三四五六七八九十')] },
    ]
    const candidates = detectBlindSpots(logs, [], 6)
    expect(candidates[0]!.excerpt).toHaveLength(6)
  })
})

describe('liveRecapLogSource', () => {
  it('returns no logs without a sessions or persistence service', async () => {
    const ctx = new Context()
    const logs = await liveRecapLogSource(ctx).list('/any-workspace')
    expect(logs).toEqual([])
  })

  it('lists only the workspace live sessions', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const workspace = await tempDir('dsh-kb-recap-live-')
    ctx.sessions.create(SessionId('in-ws'), { meta: { cwd: workspace } })
    ctx.sessions.create(SessionId('out-ws'), { meta: { cwd: '/elsewhere' } })
    const logs = await liveRecapLogSource(ctx).list(workspace)
    expect(logs.map(log => log.sessionId)).toEqual([SessionId('in-ws')])
  })

  it('merges persisted sessions with live precedence', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const workspace = await tempDir('dsh-kb-recap-persisted-')
    ctx.sessions.create(SessionId('live'), { meta: { cwd: workspace } })
    const persistence = {
      async list(): Promise<Array<{ id: SessionId; cwd: string }>> {
        return [
          { id: SessionId('live'), cwd: workspace },
          { id: SessionId('persisted'), cwd: workspace },
          { id: SessionId('other-ws'), cwd: '/elsewhere' },
        ]
      },
      async inspect(id: SessionId): Promise<{ meta: { id: SessionId }; events: SessionEvent[] }> {
        return { meta: { id }, events: [event('kb/write', { id: 'x' })] }
      },
    }
    const original = ctx.get.bind(ctx)
    ctx.get = ((name: string): unknown => name === 'sessionPersistence' ? persistence : original(name)) as typeof ctx.get
    const logs = await liveRecapLogSource(ctx).list(workspace)
    expect(logs.map(log => log.sessionId).sort()).toEqual([SessionId('live'), SessionId('persisted')])
    // Live precedence: the live session's own (empty) log wins over the persisted one.
    const liveLog = logs.find(log => log.sessionId === SessionId('live'))!
    expect(liveLog.events).toHaveLength(0)
  })

  it('logs and continues when the persistence read fails', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const workspace = await tempDir('dsh-kb-recap-persist-fail-')
    ctx.sessions.create(SessionId('live'), { meta: { cwd: workspace } })
    const persistence = {
      async list(): Promise<never> {
        throw new Error('backend down')
      },
    }
    const warns: unknown[][] = []
    const original = ctx.get.bind(ctx)
    ctx.get = ((name: string): unknown => name === 'sessionPersistence' ? persistence : original(name)) as typeof ctx.get
    ctx.logger.warn = ((...args: unknown[]) => { warns.push(args) }) as never
    const logs = await liveRecapLogSource(ctx).list(workspace)
    expect(logs.map(log => log.sessionId)).toEqual([SessionId('live')])
    expect(warns).toHaveLength(1)
    expect(String(warns[0]![0])).toContain('persisted session logs unavailable')
  })
})

describe('runRecapScan', () => {
  it('detects, lists, and records blind spots; the checkpoint dedupes a rescan', async () => {
    const workspace = await tempDir('dsh-kb-recap-scan-')
    const ctx = new Context()
    const kb = kbLike() as unknown as KbService
    const blind = SessionId('blind-1')
    const logs: RecapSessionLog[] = [
      {
        sessionId: blind,
        events: [injected([CARD]), message('user/message', '这次值班遇到新告警')],
      },
      {
        sessionId: SessionId('healthy'),
        events: [injected(['rule-20260818-002']), event('kb/write', { id: 'rule-20260818-009' })],
      },
    ]
    const first = await runRecapScan(ctx, kb, workspace, 10, logSource(logs))
    expect(first.scanDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(first.total).toBe(1)
    expect(first.entries).toHaveLength(1)
    expect(first.entries[0]!.sessionId).toBe(blind)
    expect(first.entries[0]!.consumed).toEqual([CARD])
    expect(first.entries[0]!.excerpt).toContain('这次值班遇到新告警')
    expect(first.recorded).toEqual([{ sessionId: blind, eventCount: 2 }])
    // The checkpoint file holds the recorded position.
    const file = await readFile(join(workspace, 'kb', '.kb-recap.jsonl'), 'utf8')
    expect(file).toContain('blind-1')
    // A rescan of the same logs lists nothing and records nothing.
    const second = await runRecapScan(ctx, kb, workspace, 10, logSource(logs))
    expect(second.total).toBe(0)
    expect(second.entries).toHaveLength(0)
    expect(second.recorded).toHaveLength(0)
  })

  it('pages through the queue: unlisted blind spots stay unrecorded', async () => {
    const workspace = await tempDir('dsh-kb-recap-paging-')
    const ctx = new Context()
    const kb = kbLike() as unknown as KbService
    const logs: RecapSessionLog[] = [
      { sessionId: SessionId('a'), events: [injected(['r1'], 1_700_000_000_001)] },
      { sessionId: SessionId('b'), events: [injected(['r2'], 1_700_000_000_002)] },
      { sessionId: SessionId('c'), events: [injected(['r3'], 1_700_000_000_003)] },
    ]
    const first = await runRecapScan(ctx, kb, workspace, 1, logSource(logs))
    expect(first.total).toBe(3)
    expect(first.entries.map(entry => entry.sessionId)).toEqual([SessionId('c')])
    const second = await runRecapScan(ctx, kb, workspace, 1, logSource(logs))
    expect(second.total).toBe(2)
    expect(second.entries.map(entry => entry.sessionId)).toEqual([SessionId('b')])
    const third = await runRecapScan(ctx, kb, workspace, 10, logSource(logs))
    expect(third.total).toBe(1)
    expect(third.entries.map(entry => entry.sessionId)).toEqual([SessionId('a')])
    const fourth = await runRecapScan(ctx, kb, workspace, 10, logSource(logs))
    expect(fourth.total).toBe(0)
    expect(fourth.entries).toHaveLength(0)
  })

  it('fails loud on an invalid limit', async () => {
    const workspace = await tempDir('dsh-kb-recap-limit-')
    const ctx = new Context()
    const kb = kbLike() as unknown as KbService
    await expect(runRecapScan(ctx, kb, workspace, 0, logSource([]))).rejects.toThrow('positive integer')
    await expect(runRecapScan(ctx, kb, workspace, 1.5, logSource([]))).rejects.toThrow('positive integer')
  })
})

describe('renderRecapList and recapEventPayload', () => {
  it('renders the scan as the model-facing list', () => {
    const entries: BlindSpotEntry[] = [{
      sessionId: SessionId('s1'),
      at: '2026-08-19T00:00:00.000Z',
      consumed: [CARD],
      excerpt: '摘录',
    }]
    const text = renderRecapList('2026-08-19', 3, entries)
    expect(text).toContain('知识复盘扫描（2026-08-19）')
    expect(text).toContain('发现 3 个盲点，列出 1 个')
    expect(text).toContain('s1')
    expect(text).toContain('rule-20260818-001')
    expect(text).toContain('摘录')
    // Without the truncation note when everything is listed.
    expect(renderRecapList('2026-08-19', 1, entries)).toContain('发现 1 个盲点')
    // Empty excerpts are not rendered.
    const noExcerpt = renderRecapList('2026-08-19', 1, [{ ...entries[0]!, excerpt: '' }])
    expect(noExcerpt).not.toContain('会话摘录')
  })

  it('maps a scan result into the kb/recap event payload', () => {
    const result: RecapScanResult = {
      scanDate: '2026-08-19',
      total: 2,
      entries: [{ sessionId: SessionId('s1'), at: 'at-1', consumed: [CARD], excerpt: '摘录' }],
      recorded: [{ sessionId: SessionId('s1'), eventCount: 3 }],
    }
    expect(recapEventPayload(result)).toEqual({
      scanDate: '2026-08-19',
      scanned: [{ sessionId: SessionId('s1'), eventCount: 3 }],
      blindSpots: [{ sessionId: SessionId('s1'), at: 'at-1', consumed: [CARD] }],
      total: 2,
      listed: 1,
    })
  })
})

describe('registerRecapSchedule', () => {
  function agent(ctx: Context, cwd?: string): Agent {
    void ctx
    const session = Session.create(SessionId('kb-recap-agent'), [], {
      version: 0,
      id: SessionId('kb-recap-agent'),
      createdAt: Date.now(),
      ...cwd === undefined ? {} : { cwd },
    })
    return { id: 'kb-recap-agent', session, options: {} } as unknown as Agent
  }

  function ctxWithJobs(jobs: unknown): Context {
    const ctx = new Context()
    const original = ctx.get.bind(ctx)
    ctx.get = ((name: string): unknown => name === 'jobs' ? jobs : original(name)) as typeof ctx.get
    return ctx
  }

  it('starts no job when the interval is not configured', () => {
    const started: unknown[] = []
    const ctx = ctxWithJobs({ start: (spec: unknown) => started.push(spec) })
    void ctx
    const kb = kbLike({ recapIntervalDays: 0 }) as unknown as KbService
    registerRecapSchedule(ctx, kb)
    emitAgentEvent(ctx, agent(ctx, '/ws'), 'agent/session-start', { source: 'startup' })
    expect(started).toHaveLength(0)
  })

  it('logs one loud error and skips when the interval is configured without a jobs service', () => {
    const errors: unknown[][] = []
    const ctx = new Context()
    const original = ctx.get.bind(ctx)
    ctx.get = ((name: string): unknown => original(name)) as typeof ctx.get
    ctx.logger.error = ((...args: unknown[]) => { errors.push(args) }) as never
    const kb = kbLike({ recapIntervalDays: 7 }) as unknown as KbService
    registerRecapSchedule(ctx, kb)
    emitAgentEvent(ctx, agent(ctx, '/ws'), 'agent/session-start', { source: 'startup' })
    emitAgentEvent(ctx, agent(ctx, '/ws'), 'agent/session-start', { source: 'resume' })
    expect(errors).toHaveLength(1)
    expect(String(errors[0]![0])).toContain('recapIntervalDays')
  })

  it('starts one owner-scoped job per session and skips sessions without a cwd', () => {
    const started: Array<{ kind: string; owner: Agent }> = []
    const ctx = ctxWithJobs({ start: (spec: { kind: string; owner: Agent }) => started.push(spec) })
    const kb = kbLike({ recapIntervalDays: 7 }) as unknown as KbService
    registerRecapSchedule(ctx, kb)
    const caller = agent(ctx, '/ws')
    emitAgentEvent(ctx, caller, 'agent/session-start', { source: 'startup' })
    emitAgentEvent(ctx, caller, 'agent/session-start', { source: 'resume' })
    emitAgentEvent(ctx, agent(ctx), 'agent/session-start', { source: 'startup' })
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ kind: 'kb-recap', owner: caller })
  })

  it('a job tick records positions, appends kb/recap to the owner session, and buffers the rendered list', async () => {
    vi.useFakeTimers()
    const workspace = await tempDir('dsh-kb-recap-job-')
    type JobSpec = { kind: string; owner: Agent; run: () => { cancel: () => void; done: Promise<unknown>; readOutput?: () => string } }
    const started: JobSpec[] = []
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const original = ctx.get.bind(ctx)
    ctx.get = ((name: string): unknown => name === 'jobs' ? { start: (spec: JobSpec) => started.push(spec) } : original(name)) as typeof ctx.get
    const blindSession = ctx.sessions.create(SessionId('job-blind'), { meta: { cwd: workspace } })
    blindSession.append('kb/injected', {
      pack: '测试包',
      cardIds: [CARD],
      sections: [{ name: CARD, text: '内容' }],
    })
    const kb = kbLike({ recapIntervalDays: 7 }) as unknown as KbService
    registerRecapSchedule(ctx, kb)
    const owner = agent(ctx, workspace)
    emitAgentEvent(ctx, owner, 'agent/session-start', { source: 'startup' })
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ kind: 'kb-recap', owner })
    const hooks = started[0]!.run()
    // The immediate tick runs a real scan (checkpoint read and write are real
    // IO), so wait for the tick's kb/recap append to land before reading.
    await vi.waitFor(() => {
      expect(owner.session.events.some(event => event.type === 'kb/recap')).toBe(true)
    })
    const output = hooks.readOutput?.() ?? ''
    expect(output).toContain('知识复盘扫描')
    expect(output).toContain('job-blind')
    expect(hooks.readOutput?.()).toBe('')
    // The job tick appended the kb/recap event with the recorded position.
    const recapEvents = owner.session.events.filter(event => event.type === 'kb/recap')
    expect(recapEvents).toHaveLength(1)
    expect(recapEvents[0]!.data.scanned).toEqual([{ sessionId: SessionId('job-blind'), eventCount: 1 }])
    expect(recapEvents[0]!.data.blindSpots).toEqual([{ sessionId: SessionId('job-blind'), at: expect.any(String) as unknown, consumed: [CARD] }])
    hooks.cancel()
    await expect(hooks.done).resolves.toEqual({ status: 'killed' })
  })

  it('a job tick with no blind spots appends no kb/recap event', async () => {
    vi.useFakeTimers()
    const workspace = await tempDir('dsh-kb-recap-job-empty-')
    type JobSpec = { run: () => { cancel: () => void; done: Promise<unknown>; readOutput?: () => string } }
    const started: JobSpec[] = []
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const original = ctx.get.bind(ctx)
    ctx.get = ((name: string): unknown => name === 'jobs' ? { start: (spec: JobSpec) => started.push(spec) } : original(name)) as typeof ctx.get
    const kb = kbLike({ recapIntervalDays: 7 }) as unknown as KbService
    registerRecapSchedule(ctx, kb)
    const owner = agent(ctx, workspace)
    emitAgentEvent(ctx, owner, 'agent/session-start', { source: 'startup' })
    const hooks = started[0]!.run()
    await vi.waitFor(() => {
      expect(hooks.readOutput?.() ?? '').toContain('发现 0 个盲点')
    })
    expect(owner.session.events.filter(event => event.type === 'kb/recap')).toHaveLength(0)
    hooks.cancel()
    await expect(hooks.done).resolves.toEqual({ status: 'killed' })
  })
})
