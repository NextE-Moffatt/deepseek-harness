/**
 * Agent-loop mock integration for `@deepseek-ai/dsh-kb-web`: the workbench
 * composes beside the real agent-loop machinery (the testkit's session store,
 * agent registry, and tool runtime) and its human-driven actions land in the
 * same session log surface the loop replays — a consumed-but-unwritten session
 * surfaces as a blind spot, and a workbench promotion is reconstructable from
 * the log alone. Only the loop machinery is the testkit's; cards, ledgers,
 * and events are real.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import KbService from '@deepseek-ai/dsh-kb-core'
import type { CardId } from '@deepseek-ai/dsh-kb-core'
import KbWorkbenchService from '@deepseek-ai/dsh-kb-web'
import type { KbWorkbenchService as KbWorkbenchServiceType } from '@deepseek-ai/dsh-kb-web'

let context: Context | undefined
let workspace: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true })
  workspace = undefined
})

async function harness(): Promise<{ ctx: Context; workbench: Session; kb: KbService; service: KbWorkbenchServiceType }> {
  const ctx = new Context()
  context = ctx
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(KbService, { cardTtlDays: 90 })
  await ctx.plugin(KbWorkbenchService)
  workspace = await mkdtemp(join(tmpdir(), 'dsh-kb-web-loop-'))
  const workbench = ctx.sessions.create(SessionId('workbench'), { meta: { cwd: workspace } })
  return {
    ctx,
    workbench,
    kb: ctx.get('kb') as KbService,
    service: ctx.get('kbWorkbench') as KbWorkbenchServiceType,
  }
}

/** A registry-compatible agent whose session cwd is the workspace. */
function agent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd: workspace! } })
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  const value: Agent = {
    id: SessionId(id), options: {}, session,
    inbox,
    status: 'idle', ctx: new Context(),
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

/** Fold one event type out of a session log. */
function eventsOf(log: readonly SessionEvent[], type: string): readonly SessionEvent[] {
  return log.filter(event => event.type === type)
}

describe('kb workbench beside the agent loop', () => {
  it('surfaces a consumed-without-producing loop session as a blind spot and logs human actions into the replayable stream', async () => {
    const { ctx, workbench, kb, service } = await harness()
    const model = agent(ctx, 'model-session')
    // The loop session consumed injected knowledge but produced no card: a blind spot.
    model.session.append('kb/injected', {
      pack: '测试包', cardIds: ['rule-20260801-001' as CardId], sections: [{ name: 'rule-20260801-001', text: '内容' }],
    })
    // The model's own production path: a real draft card.
    await kb.writeCard(workspace!, {
      tier: 'P2', id: 'rule-20260801-001' as CardId, type: 'rule', title: '规则',
      适用条件: '任何会话', 核心结论: '结论', 应做: ['做'], 不应做: ['不做'],
      责任人: '本人', 有效期: '2099-01-01', 标签: ['kb'],
    } as never)

    // The workbench overview lists the loop session's blind spot.
    const overview = await service.overview(workbench)
    expect(overview.blindSpots).toHaveLength(1)
    expect(overview.blindSpots[0]).toMatchObject({ sessionId: SessionId('model-session'), consumed: ['rule-20260801-001'] })
    expect(overview.metrics.blindSpots).toBe(1)

    // A human promotion rides the same session-log machinery the loop replays.
    const promoted = await service.promote(workbench, 'rule-20260801-001', 'pending')
    expect(promoted.to).toBe('pending')
    const promoteEvents = eventsOf(workbench.events, 'kb/promote')
    expect(promoteEvents).toHaveLength(1)
    expect(promoteEvents[0]!.data).toEqual({ id: 'rule-20260801-001', from: 'draft', to: 'pending' })

    // The replay is stable: folding the log reproduces the promotion chain.
    const replay = eventsOf(workbench.events, 'kb/promote').map(event => event.data)
    expect(replay).toEqual([{ id: 'rule-20260801-001', from: 'draft', to: 'pending' }])

    // The store's session surface sees the same log the loop would project.
    const storeSession = ctx.sessions.get(SessionId('workbench'))
    expect(storeSession).toBe(workbench)
    expect(storeSession!.events).toBe(workbench.events)
  })
})
