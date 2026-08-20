// kb-telemetry coverage: the session-log projection, the ledger's
// append/read/rebuild lifecycle, the aggregation, and the live listener
// consuming session/event dispatches.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { HeatLedger, aggregateHeat, projectInjectedHeat, registerKbTelemetry } from '../src/telemetry.ts'
import type { CardId } from '../src/types.ts'

let roots: string[] = []
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots = []
})

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-kb-heat-'))
  roots.push(root)
  return root
}

/** A minimal session event of the requested type. */
function event(type: SessionEvent['type'], data: Record<string, unknown>, time = 1_700_000_000_000): SessionEvent {
  return { type, data, seq: 1, time } as SessionEvent
}

const SESSION = SessionId('session-a')

describe('projectInjectedHeat', () => {
  it('projects one entry per injected card, ignoring other events', () => {
    const events = [
      event('kb/injected', {
        pack: '告警处置',
        cardIds: ['rule-20260818-001' as CardId, 'rule-20260818-002' as CardId],
        sections: [{ name: 'rule-20260818-001', text: 'x' }, { name: 'rule-20260818-002', text: 'y' }],
      }),
      event('kb/write', { id: 'rule-20260818-003' }),
      event('user/message', { content: [] }),
    ]
    const entries = projectInjectedHeat(SESSION, events)
    expect(entries).toEqual([
      { cardId: 'rule-20260818-001' as CardId, sessionId: SESSION, at: new Date(1_700_000_000_000).toISOString(), pack: '告警处置' },
      { cardId: 'rule-20260818-002' as CardId, sessionId: SESSION, at: new Date(1_700_000_000_000).toISOString(), pack: '告警处置' },
    ])
  })

  it('projects an empty log to no entries', () => {
    expect(projectInjectedHeat(SESSION, [])).toEqual([])
  })
})

describe('HeatLedger', () => {
  it('appends, reads, and rebuilds the JSONL ledger', async () => {
    const root = await tempDir()
    const path = join(root, 'kb', '.kb-heat.jsonl')
    const ledger = new HeatLedger(path)
    expect(await ledger.readAll()).toEqual([])
    await ledger.append([
      { cardId: 'rule-20260818-001' as CardId, sessionId: SESSION, at: '2026-08-19T00:00:00.000Z', pack: '告警处置' },
    ])
    await ledger.append([
      { cardId: 'rule-20260818-001' as CardId, sessionId: SESSION, at: '2026-08-19T01:00:00.000Z', pack: '告警处置' },
    ])
    const entries = await ledger.readAll()
    expect(entries).toHaveLength(2)
    await ledger.writeAll([
      { cardId: 'rule-20260818-002' as CardId, sessionId: SessionId('session-b'), at: '2026-08-19T02:00:00.000Z', pack: '巡检' },
    ])
    expect(await ledger.readAll()).toHaveLength(1)
    expect(await readFile(path, 'utf8')).toContain('rule-20260818-002')
  })

  it('writeAll with no entries writes an empty file', async () => {
    const root = await tempDir()
    const ledger = new HeatLedger(join(root, 'kb', 'empty-rebuild.jsonl'))
    await ledger.writeAll([])
    expect(await readFile(ledger.path, 'utf8')).toBe('')
  })

  it('appending nothing writes nothing', async () => {
    const root = await tempDir()
    const ledger = new HeatLedger(join(root, 'kb', 'empty.jsonl'))
    await ledger.append([])
    await expect(readFile(ledger.path, 'utf8')).rejects.toThrow()
  })

  it('fails loud when the ledger path is a directory (non-ENOENT read error)', async () => {
    const root = await tempDir()
    await mkdir(join(root, 'kb'), { recursive: true })
    const path = join(root, 'kb', 'ledger-dir')
    await mkdir(path)
    await expect(new HeatLedger(path).readAll()).rejects.toThrow()
  })

  it('fails loud on a malformed ledger line', async () => {
    const root = await tempDir()
    const path = join(root, 'kb', '.kb-heat.jsonl')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(root, 'kb'), { recursive: true })
    await writeFile(path, 'not-json\n', 'utf8')
    await expect(new HeatLedger(path).readAll()).rejects.toThrow()
  })
})

describe('aggregateHeat', () => {
  it('aggregates per card with counts, sessions, packs, and last access', () => {
    const rows = aggregateHeat([
      { cardId: 'rule-20260818-002' as CardId, sessionId: SessionId('b'), at: '2026-08-19T02:00:00.000Z', pack: '巡检' },
      { cardId: 'rule-20260818-001' as CardId, sessionId: SESSION, at: '2026-08-19T01:00:00.000Z', pack: '告警处置' },
      { cardId: 'rule-20260818-001' as CardId, sessionId: SessionId('b'), at: '2026-08-19T03:00:00.000Z', pack: '告警处置' },
    ])
    expect(rows).toEqual([
      {
        cardId: 'rule-20260818-001' as CardId,
        count: 2,
        lastAt: '2026-08-19T03:00:00.000Z',
        sessions: ['b', 'session-a'],
        packs: ['告警处置'],
      },
      {
        cardId: 'rule-20260818-002' as CardId,
        count: 1,
        lastAt: '2026-08-19T02:00:00.000Z',
        sessions: ['b'],
        packs: ['巡检'],
      },
    ])
  })

  it('aggregates no entries to no rows', () => {
    expect(aggregateHeat([])).toEqual([])
  })
})

describe('registerKbTelemetry', () => {
  it('appends injected cards to the workspace ledger from session/event dispatches', async () => {
    const root = await tempDir()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const kb = { config: { heatPath: 'kb/.kb-heat.jsonl' } } as unknown as Parameters<typeof registerKbTelemetry>[1]
    registerKbTelemetry(ctx, kb)

    const session = ctx.sessions.create(SessionId('telemetry-session'), { meta: { cwd: root } })
    session.append('kb/injected', {
      pack: '告警处置',
      cardIds: ['rule-20260818-001' as CardId],
      sections: [{ name: 'rule-20260818-001', text: 'x' }],
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    const entries = await new HeatLedger(join(root, 'kb', '.kb-heat.jsonl')).readAll()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.cardId).toBe('rule-20260818-001' as CardId)
    expect(entries[0]!.sessionId).toBe('telemetry-session')
    await ctx.fiber.dispose()
  })

  it('contains a ledger append failure without throwing', async () => {
    const root = await tempDir()
    // A file where the ledger directory should be forces the append to fail.
    await writeFile(join(root, 'blocked'), 'file', 'utf8')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const kb = { config: { heatPath: 'blocked/ledger.jsonl' } } as unknown as Parameters<typeof registerKbTelemetry>[1]
    registerKbTelemetry(ctx, kb)
    const session = ctx.sessions.create(SessionId('blocked-session'), { meta: { cwd: root } })
    expect(() => {
      session.append('kb/injected', {
        pack: 'p',
        cardIds: ['rule-20260818-001' as CardId],
        sections: [{ name: 'rule-20260818-001', text: 'x' }],
      })
    }).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 10))
    await ctx.fiber.dispose()
  })

  it('ignores unrelated dispatches and sessions without a workspace', async () => {
    const root = await tempDir()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const kb = { config: { heatPath: 'kb/.kb-heat.jsonl' } } as unknown as Parameters<typeof registerKbTelemetry>[1]
    registerKbTelemetry(ctx, kb)
    // A session without a cwd: an injection must not throw or write.
    const noCwd = ctx.sessions.create(SessionId('no-cwd'))
    noCwd.append('kb/injected', {
      pack: 'p',
      cardIds: ['rule-20260818-001' as CardId],
      sections: [{ name: 'rule-20260818-001', text: 'x' }],
    })
    // A cwd session appending an unrelated event must not write either.
    const unrelated = ctx.sessions.create(SessionId('unrelated'), { meta: { cwd: root } })
    unrelated.append('kb/promote', { id: 'rule-20260818-002' as CardId, from: 'draft', to: 'pending' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(await new HeatLedger(join(root, 'kb', '.kb-heat.jsonl')).readAll()).toEqual([])
    await ctx.fiber.dispose()
  })
})
