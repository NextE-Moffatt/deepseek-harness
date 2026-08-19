import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as KbInvariant from '@deepseek-ai/dsh-kb-core/invariant'
import type { CardId } from '../src/types.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(KbInvariant)
  return ctx
}

function event(type: SessionEvent['type'], data: unknown): SessionEvent {
  return { type, seq: 0, time: 0, data } as SessionEvent
}

describe('kb event invariants', () => {
  it('accepts a coherent kb/write, kb/promote, and kb/injected on live appends', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    ctx.sessions.create().append('kb/write', {
      id: 'rule-20250818-001' as CardId,
      library: 'personal',
      tier: 'P2',
      status: 'draft',
      title: 't',
      path: '/tmp/card.md',
    })
    const session = ctx.sessions.list()[0]!
    session.append('kb/promote', { id: 'rule-20250818-001' as CardId, from: 'draft', to: 'pending', evidence: 'MR#1' })
    session.append('kb/injected', {
      pack: '告警处置',
      cardIds: ['rule-20250818-001' as CardId],
      sections: [{ name: 'rule-20250818-001', text: '标题：t\n适用条件：值班收到告警' }],
    })
    session.append('kb/team-join', { id: 'rule-20250818-001' as CardId, path: '/team/cards/rule-20250818-001.md', status: 'pending' })
    session.append('kb/recap', {
      scanDate: '2026-08-19',
      scanned: [{ sessionId: session.id, eventCount: 4 }],
      blindSpots: [{ sessionId: session.id, at: '2026-08-19T00:00:00.000Z', consumed: ['rule-20250818-001' as CardId] }],
      total: 1,
      listed: 1,
    })
    await ctx.plugin(KbInvariant)
  })

  it.each([
    ['kb/write blank id', 'kb/write', { id: '', library: 'personal', tier: 'P2', status: 'draft', title: 't', path: '/x' }, /id must be a non-empty string/],
    ['kb/write bad library', 'kb/write', { id: 'a-1', library: 'work', tier: 'P2', status: 'draft', title: 't', path: '/x' }, /library must be one of/],
    ['kb/write bad tier', 'kb/write', { id: 'a-1', library: 'personal', tier: 'P9', status: 'draft', title: 't', path: '/x' }, /tier must be one of/],
    ['kb/write bad status', 'kb/write', { id: 'a-1', library: 'personal', tier: 'P2', status: 'done', title: 't', path: '/x' }, /status must be one of/],
    ['kb/write blank title', 'kb/write', { id: 'a-1', library: 'personal', tier: 'P2', status: 'draft', title: '', path: '/x' }, /title must be a non-empty string/],
    ['kb/write blank path', 'kb/write', { id: 'a-1', library: 'personal', tier: 'P2', status: 'draft', title: 't', path: '' }, /path must be a non-empty string/],
    ['kb/promote blank id', 'kb/promote', { id: '', from: 'draft', to: 'pending' }, /id must be a non-empty string/],
    ['kb/promote bad from', 'kb/promote', { id: 'a-1', from: 'done', to: 'pending' }, /from must be one of/],
    ['kb/promote bad to', 'kb/promote', { id: 'a-1', from: 'draft', to: 'done' }, /to must be one of/],
    ['kb/promote no change', 'kb/promote', { id: 'a-1', from: 'draft', to: 'draft' }, /must change the card state/],
    ['kb/promote illegal transition', 'kb/promote', { id: 'a-1', from: 'draft', to: 'ready' }, /not in the state machine/],
    ['kb/promote blank evidence', 'kb/promote', { id: 'a-1', from: 'draft', to: 'pending', evidence: '' }, /evidence must be a non-empty string/],
    ['kb/injected blank pack', 'kb/injected', { pack: '', cardIds: ['a'], sections: [{ name: 'a', text: 't' }] }, /pack must be a non-empty string/],
    ['kb/injected empty cardIds', 'kb/injected', { pack: 'p', cardIds: [], sections: [] }, /cardIds must be a non-empty array/],
    ['kb/injected empty sections', 'kb/injected', { pack: 'p', cardIds: ['a'], sections: [] }, /sections must be a non-empty array/],
    ['kb/injected bad cardIds item', 'kb/injected', { pack: 'p', cardIds: [''], sections: [{ name: 'a', text: 't' }] }, /cardIds must contain only non-empty strings/],
    ['kb/injected blank section name', 'kb/injected', { pack: 'p', cardIds: ['a'], sections: [{ name: '', text: 't' }] }, /section name must be a non-empty string/],
    ['kb/injected blank section text', 'kb/injected', { pack: 'p', cardIds: ['a'], sections: [{ name: 'a', text: '' }] }, /section text must be a non-empty string/],
    ['kb/injected length mismatch', 'kb/injected', { pack: 'p', cardIds: ['a', 'b'], sections: [{ name: 'a', text: 't' }] }, /must have the same length/],
    ['kb/injected name/id drift', 'kb/injected', { pack: 'p', cardIds: ['a'], sections: [{ name: 'b', text: 't' }] }, /must equal the card ids in order/],
    ['kb/team-join blank id', 'kb/team-join', { id: '', path: '/x', status: 'pending' }, /id must be a non-empty string/],
    ['kb/team-join blank path', 'kb/team-join', { id: 'a-1', path: '', status: 'pending' }, /path must be a non-empty string/],
    ['kb/team-join bad status', 'kb/team-join', { id: 'a-1', path: '/x', status: 'done' }, /status must be one of/],
    ['kb/recap blank scanDate', 'kb/recap', { scanDate: '', scanned: [], blindSpots: [], total: 0, listed: 0 }, /scanDate must be a non-empty string/],
    ['kb/recap scanned not array', 'kb/recap', { scanDate: '2026-08-19', scanned: {}, blindSpots: [], total: 0, listed: 0 }, /scanned must be an array/],
    ['kb/recap blindSpots not array', 'kb/recap', { scanDate: '2026-08-19', scanned: [], blindSpots: {}, total: 0, listed: 0 }, /blindSpots must be an array/],
    ['kb/recap blank scanned sessionId', 'kb/recap', { scanDate: '2026-08-19', scanned: [{ sessionId: '', eventCount: 1 }], blindSpots: [], total: 0, listed: 0 }, /scanned sessionId must be a non-empty string/],
    ['kb/recap negative scanned eventCount', 'kb/recap', { scanDate: '2026-08-19', scanned: [{ sessionId: 's', eventCount: -1 }], blindSpots: [], total: 0, listed: 0 }, /scanned eventCount must be a non-negative integer/],
    ['kb/recap blank blindSpots sessionId', 'kb/recap', { scanDate: '2026-08-19', scanned: [], blindSpots: [{ sessionId: '', at: 'a', consumed: [] }], total: 0, listed: 0 }, /blindSpots sessionId must be a non-empty string/],
    ['kb/recap blank blindSpots at', 'kb/recap', { scanDate: '2026-08-19', scanned: [], blindSpots: [{ sessionId: 's', at: '', consumed: [] }], total: 0, listed: 0 }, /blindSpots at must be a non-empty string/],
    ['kb/recap blank consumed item', 'kb/recap', { scanDate: '2026-08-19', scanned: [], blindSpots: [{ sessionId: 's', at: 'a', consumed: [''] }], total: 0, listed: 0 }, /blindSpots consumed must be an array of non-empty strings/],
    ['kb/recap negative total', 'kb/recap', { scanDate: '2026-08-19', scanned: [], blindSpots: [], total: -1, listed: 0 }, /total must be a non-negative integer/],
    ['kb/recap negative listed', 'kb/recap', { scanDate: '2026-08-19', scanned: [], blindSpots: [], total: 0, listed: -1 }, /listed must be a non-negative integer/],
  ])('rejects %s', async (_name, type, data, message) => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, event(type as SessionEvent['type'], data)) }).toThrow(message)
  })

  it('rejects a kb/write already in the log when the companion mounts', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    ctx.sessions.create().append('kb/write', {
      id: '' as CardId,
      library: 'personal',
      tier: 'P2',
      status: 'draft',
      title: 't',
      path: '/x',
    })
    await expect(ctx.plugin(KbInvariant)).rejects.toThrow(/id must be a non-empty string/)
  })

  it('ignores unrelated dispatches and session events', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('tools/change')
      ctx.emit('session/event', {} as Session, { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })
    }).not.toThrow()
  })
})
