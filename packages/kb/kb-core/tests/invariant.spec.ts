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
  it('accepts a coherent kb/write and kb/promote on live appends', async () => {
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
