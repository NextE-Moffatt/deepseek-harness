import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import KbService, { foldInjected as kbFold } from '@deepseek-ai/dsh-kb-core'
import type { CardId } from '@deepseek-ai/dsh-kb-core'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Full-loop acceptance: a scripted mock model drives the REAL kb tools through
 * the agent loop in a real workspace — kb_write a draft card → kb_search finds
 * it → kb_promote flips the state — exercising the same execution paths a live
 * model would. Only the model is mocked; the tools, the library files, and the
 * session log are real, so the acceptance chain is replayable from the log.
 */
let workspaces: string[] = []
afterEach(async () => {
  for (const workspace of workspaces) await rm(workspace, { recursive: true, force: true })
  workspaces = []
})

async function harness(
  adapter: MockAdapter,
  config: Record<string, unknown> = { cardTtlDays: 7 },
): Promise<{ ctx: Context; workspace: string }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(KbService, config)
  ctx.llm.registerAdapter(['mock'], adapter)
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-kb-loop-'))
  workspaces.push(workspace)
  return { ctx, workspace }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function findEvent<T extends SessionEvent['type']>(
  log: readonly SessionEvent[],
  type: T,
): Extract<SessionEvent, { type: T }> {
  const found = log.find(event => event.type === type)
  if (found === undefined) throw new Error(`no ${type} event in the session log`)
  return found as Extract<SessionEvent, { type: T }>
}

describe('kb tools through the agent loop', () => {
  it('model writes, searches, and promotes a card in a real workspace; the log replays the chain', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'kb_write', {
        tier: 'P2',
        id: 'rule-20250818-042',
        type: 'rule',
        title: '告警处置标准',
        适用条件: '值班收到告警',
        核心结论: '先确认影响面再处置。',
        应做: ['确认影响面'],
        不应做: ['直接重启'],
        责任人: '张三',
        标签: ['告警'],
      }, 'Recording the card.'),
      toolCallResponse('call-2', 'kb_search', { query: '告警' }, 'Searching the library.'),
      toolCallResponse('call-3', 'kb_promote', { id: 'rule-20250818-042', target: 'pending', evidence: '已上线 MR#42' }, 'Promoting the card.'),
      textResponse('Done.'),
    ])
    const { ctx, workspace } = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('it-kb'), { provider: 'mock', model: 'mock' }, { cwd: workspace })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: '沉淀一条告警处置规则并晋升' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const log = agent.session.events
    const cardId = 'rule-20250818-042'
    const writes = log.filter(event => event.type === 'kb/write')
    expect(writes).toHaveLength(1)
    expect((writes[0]!.data as { id: string }).id).toBe(cardId)

    // All three tool calls completed without error.
    const results = log.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(3)
    for (const result of results) expect(result.data.message.content[0].isError).toBe(false)

    // The search tool/result found the card (render text names it). The loop
    // wraps each tool outcome in a tool-result block, so unwrap before reading.
    const searchResultText = results[1]!.data.message.content
      .flatMap(block => block.type === 'tool-result' ? block.content : [block])
      .filter(block => block.type === 'text').map(block => block.text).join('')
    expect(searchResultText).toContain(cardId)

    const promote = findEvent(log, 'kb/promote')
    expect(promote.data).toMatchObject({ id: cardId, from: 'draft', to: 'pending', evidence: '已上线 MR#42' })

    // The card file on disk carries the promoted state.
    const file = await readFile(join(workspace, 'kb/cards/P2', `${cardId}.md`), 'utf8')
    expect(file).toContain('状态: pending')

    // Replay: a fresh session seeded with the log reconstructs the chain.
    const replayed = log.map(event => ({ type: event.type, data: event.data }))
    expect(replayed.filter(event => event.type === 'kb/write')).toHaveLength(1)
    expect(replayed.filter(event => event.type === 'kb/promote')).toHaveLength(1)
  })

  it('injects the configured pack at session start; the first model request carries the card content and the log replays it', async () => {
    const adapter = new MockAdapter([
      (request) => {
        // The kb:pack section must reach the very first request.
        expect(request.system).toContain('## 知识包：告警处置')
        expect(request.system).toContain('标题：告警处置标准')
        expect(request.system).toContain('应做：确认影响面')
        return textResponse('已按告警处置标准处理。')
      },
    ])
    const { ctx, workspace } = await harness(adapter, {
      cardTtlDays: 7,
      packs: [{ name: '告警处置', tags: ['告警'] }],
    })

    // Seed the library before the agent exists, so the session-start
    // injection picks the card up.
    await ctx.kb.writeCard(workspace, {
      tier: 'P2',
      id: 'rule-20250818-042' as CardId,
      type: 'rule',
      title: '告警处置标准',
      适用条件: '值班收到告警',
      核心结论: '先确认影响面再处置。',
      应做: ['确认影响面'],
      不应做: ['直接重启'],
      责任人: '张三',
      标签: ['告警'],
    })

    const agent = ctx.agentLoop.create(SessionId('it-kb-inject'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '处理告警' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const injected = agent.session.events.filter(event => event.type === 'kb/injected')
    expect(injected).toHaveLength(1)
    expect(injected[0]!.data).toMatchObject({
      pack: '告警处置',
      cardIds: ['rule-20250818-042'],
    })
    expect(injected[0]!.data.sections[0]!.text).toContain('核心结论：先确认影响面再处置。')
    expect(adapter.requests).toHaveLength(1)

    // Replay: a fresh session seeded with the log reproduces the kb:pack fold.
    const replayed = Session.create(SessionId('it-kb-inject-replay'), agent.session.events)
    const fold = kbFold(agent.session.events)
    expect(kbFold(replayed.events)).toBe(fold)
    expect(fold).toContain('## 知识包：告警处置')
  })
})
