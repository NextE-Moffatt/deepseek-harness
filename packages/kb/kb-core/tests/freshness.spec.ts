// kb-govern freshness coverage: the two-library scan with heat, the
// producer's immediate-tick/interval/cancel lifecycle, and the session-start
// scheduler registration (interval off, jobs missing, no cwd, per-session
// once-only, and owner-scoped start).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createFreshnessProducer, freshnessReview, registerFreshnessSchedule } from '../src/freshness.ts'
import type { KbService } from '../src/index.ts'
import { HeatLedger } from '../src/telemetry.ts'
import type { CardId } from '../src/types.ts'
import type { ResolvedKbConfig } from '../src/index.ts'

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

/** A personal card file with the given id, status, and expiry. */
function personalCardFile(id: string, status: string, expiresAt: string): string {
  return `---
id: ${id}
type: rule
title: 卡片 ${id}
库: personal
状态: ${status}
适用条件: 值班
责任人: 张三
有效期: ${expiresAt}
标签:
  - 告警
---

## 核心结论

结论。

## 应做

- 做

## 不应做

- 不做
`
}

/** A minimal kb service face for the scan and scheduler. */
function kbLike(config: Partial<ResolvedKbConfig>, teamRoot?: string): {
  config: ResolvedKbConfig
  teamRepoRoot: (root: string) => string
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
    teamRepoRoot: () => teamRoot ?? '',
    ctx: { logger: { debug: () => {}, warn: () => {}, error: () => {} } },
  }
}

describe('freshnessReview', () => {
  it('partitions personal and team cards with heat and recommendations', async () => {
    const workspace = await tempDir('dsh-kb-fresh-ws-')
    const teamRoot = await tempDir('dsh-kb-fresh-team-')
    await mkdir(join(workspace, 'kb/cards/P2'), { recursive: true })
    await writeFile(join(workspace, 'kb/cards/P2', 'rule-20260818-001.md'), personalCardFile('rule-20260818-001', 'ready', '2026-08-01'), 'utf8')
    await writeFile(join(workspace, 'kb/cards/P2', 'rule-20260818-002.md'), personalCardFile('rule-20260818-002', 'ready', '2026-08-25'), 'utf8')
    await mkdir(join(teamRoot, '.git'))
    await mkdir(join(teamRoot, 'cards'))
    const teamCard = personalCardFile('rule-20260818-003', 'pending', '2027-01-01').replace('库: personal', '库: team')
    await writeFile(join(teamRoot, 'cards', 'rule-20260818-003.md'), teamCard, 'utf8')
    // Seed heat: the overdue personal card was consumed twice.
    await new HeatLedger(join(workspace, 'kb', '.kb-heat.jsonl')).append([
      { cardId: 'rule-20260818-001' as CardId, sessionId: SessionId('s1'), at: '2026-08-10T00:00:00.000Z', pack: '告警处置' },
      { cardId: 'rule-20260818-001' as CardId, sessionId: SessionId('s1'), at: '2026-08-11T00:00:00.000Z', pack: '告警处置' },
    ])
    const ctx = new Context()
    const kb = kbLike({ teamRepoPath: teamRoot }, teamRoot) as unknown as KbService

    const review = await freshnessReview(ctx, kb, workspace, '2026-08-19')
    expect(review.total).toBe(2)
    const overdue = review.overdue
    expect(overdue).toHaveLength(1)
    expect(overdue[0]).toMatchObject({ id: 'rule-20260818-001', library: 'personal', heat: 2, recommend: 'renew' })
    const soon = review.expiringSoon
    expect(soon.map(e => e.id)).toEqual(['rule-20260818-002'])
    expect(soon[0]).toMatchObject({ library: 'personal', recommend: 'renew' })
    // The team pending card inside its window does not appear.
    expect(review.overdue.some(e => e.id === 'rule-20260818-003')).toBe(false)
    expect(review.expiringSoon.some(e => e.id === 'rule-20260818-003')).toBe(false)
  })

  it('reports per-file parse failures in both libraries and keeps scanning', async () => {
    const workspace = await tempDir('dsh-kb-fresh-parse-')
    const teamRoot = await tempDir('dsh-kb-fresh-parse-team-')
    await mkdir(join(workspace, 'kb/cards/P2'), { recursive: true })
    await writeFile(join(workspace, 'kb/cards/P2', 'broken-personal.md'), 'not a card', 'utf8')
    await writeFile(join(workspace, 'kb/cards/P2', 'rule-20260818-001.md'), personalCardFile('rule-20260818-001', 'ready', '2026-08-01'), 'utf8')
    await mkdir(join(teamRoot, '.git'))
    await mkdir(join(teamRoot, 'cards'))
    await writeFile(join(teamRoot, 'cards', 'broken-team.md'), 'not a card', 'utf8')
    await writeFile(join(teamRoot, 'cards', 'rule-20260818-003.md'), personalCardFile('rule-20260818-003', 'pending', '2026-08-10'), 'utf8')
    const ctx = new Context()
    const kb = kbLike({ teamRepoPath: teamRoot }, teamRoot) as unknown as KbService
    const review = await freshnessReview(ctx, kb, workspace, '2026-08-19')
    expect(review.overdue.map(e => e.id)).toEqual(['rule-20260818-001', 'rule-20260818-003'])
  })

  it('continues with the personal side when the team repository is unreadable', async () => {
    const workspace = await tempDir('dsh-kb-fresh-ws2-')
    await mkdir(join(workspace, 'kb/cards/P2'), { recursive: true })
    await writeFile(join(workspace, 'kb/cards/P2', 'rule-20260818-001.md'), personalCardFile('rule-20260818-001', 'ready', '2026-08-01'), 'utf8')
    const ctx = new Context()
    const kb = kbLike({ teamRepoPath: '/does/not/exist' }, '/does/not/exist') as unknown as KbService
    const review = await freshnessReview(ctx, kb, workspace, '2026-08-19')
    expect(review.overdue.map(e => e.id)).toEqual(['rule-20260818-001'])
  })
})

describe('createFreshnessProducer', () => {
  it('scans immediately, then every interval days, buffers output, and cancels', async () => {
    vi.useFakeTimers()
    const scan = vi.fn(async () => '待复核清单 v1')
    const hooks = createFreshnessProducer(scan, 3)
    await vi.advanceTimersByTimeAsync(0)
    expect(scan).toHaveBeenCalledTimes(1)
    expect(hooks.readOutput?.()).toBe('待复核清单 v1\n')
    // Day 1 and 2 ticks do not rescan; day 3 does.
    await vi.advanceTimersByTimeAsync(86_400_000 * 3)
    expect(scan).toHaveBeenCalledTimes(2)
    expect(hooks.readOutput?.()).toBe('待复核清单 v1\n')
    await vi.advanceTimersByTimeAsync(86_400_000 * 6)
    expect(scan).toHaveBeenCalledTimes(4)
    const outcome = hooks.done.then(() => 'settled')
    hooks.cancel('disposed')
    await expect(outcome).resolves.toBe('settled')
    await expect(hooks.done).resolves.toEqual({ status: 'killed' })
  })

  it('buffers nothing when a scan returns an empty list and keeps going on failure', async () => {
    vi.useFakeTimers()
    const scan = vi.fn()
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(new Error('scan failed'))
    const hooks = createFreshnessProducer(scan, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(hooks.readOutput?.()).toBe('')
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(scan).toHaveBeenCalledTimes(2)
    hooks.cancel()
    await expect(hooks.done).resolves.toEqual({ status: 'killed' })
  })
})

describe('registerFreshnessSchedule', () => {
  function agent(ctx: Context, cwd?: string): Agent {
    void ctx
    const session = Session.create(SessionId('kb-fresh-agent'), [], {
      version: 0,
      id: SessionId('kb-fresh-agent'),
      createdAt: Date.now(),
      ...cwd === undefined ? {} : { cwd },
    })
    return { id: 'kb-fresh-agent', session, options: {} } as unknown as Agent
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
    const kb = kbLike({ freshnessIntervalDays: 0 }) as unknown as KbService
    registerFreshnessSchedule(ctx, kb)
    emitAgentEvent(ctx, agent(ctx, '/ws'), 'agent/session-start', { source: 'startup' })
    expect(started).toHaveLength(0)
  })

  it('logs one loud error and skips when the interval is configured without a jobs service', () => {
    const errors: unknown[][] = []
    const ctx = new Context()
    const original = ctx.get.bind(ctx)
    ctx.get = ((name: string): unknown => original(name)) as typeof ctx.get
    ctx.logger.error = ((...args: unknown[]) => { errors.push(args) }) as never
    const kb = kbLike({ freshnessIntervalDays: 7 }) as unknown as KbService
    registerFreshnessSchedule(ctx, kb)
    emitAgentEvent(ctx, agent(ctx, '/ws'), 'agent/session-start', { source: 'startup' })
    emitAgentEvent(ctx, agent(ctx, '/ws'), 'agent/session-start', { source: 'resume' })
    expect(errors).toHaveLength(1)
    expect(String(errors[0]![0])).toContain('freshnessIntervalDays')
  })

  it('starts one owner-scoped job per session and skips sessions without a cwd', () => {
    const started: Array<{ kind: string; owner: Agent }> = []
    const ctx = ctxWithJobs({ start: (spec: { kind: string; owner: Agent }) => started.push(spec) })
    const kb = kbLike({ freshnessIntervalDays: 7 }) as unknown as KbService
    registerFreshnessSchedule(ctx, kb)
    const caller = agent(ctx, '/ws')
    emitAgentEvent(ctx, caller, 'agent/session-start', { source: 'startup' })
    emitAgentEvent(ctx, caller, 'agent/session-start', { source: 'resume' })
    emitAgentEvent(ctx, agent(ctx), 'agent/session-start', { source: 'startup' })
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ kind: 'kb-freshness', owner: caller })
  })
})
