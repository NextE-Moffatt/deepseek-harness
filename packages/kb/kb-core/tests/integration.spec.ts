import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
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

describe('milestone-3 team chain through the agent loop', () => {
  const execFileAsync = promisify(execFile)

  async function makeTeamRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), 'dsh-kb-loop-team-'))
    workspaces.push(repo)
    await execFileAsync('git', ['init', '-q', repo])
    await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'kb-test@example.com'])
    await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'kb test'])
    return repo
  }

  /** A ready team card file seeded into the repository before the agent exists. */
  const READY_TEAM_CARD = `---
id: rule-20260818-100
type: rule
title: 团队告警处置基线
库: team
状态: ready
适用条件: 值班收到团队告警
来源: MR#1
责任人: 李四
有效期: 2026-12-31
标签:
  - 告警
---

## 核心结论

按基线处置。

## 应做

- 按基线处置

## 不应做

- 私自变通
`

  it('team pack injects at session start; the loop drives gate → promote → review → commit, replayable from the log', async () => {
    const teamRepo = await makeTeamRepo()
    await mkdir(join(teamRepo, 'cards'))
    await writeFile(join(teamRepo, 'cards', 'rule-20260818-100.md'), READY_TEAM_CARD, 'utf8')
    await execFileAsync('git', ['-C', teamRepo, 'add', '-A'])
    await execFileAsync('git', ['-C', teamRepo, 'commit', '-q', '-m', '种子卡片'])

    const adapter = new MockAdapter([
      (request) => {
        // The team pack reached the first request through kb:pack.
        expect(request.system).toContain('## 知识包：团队告警')
        expect(request.system).toContain('### rule-20260818-100')
        return toolCallResponse('loop-call-1', 'kb_write', {
          tier: 'P2',
          id: 'rule-20260818-200',
          type: 'rule',
          title: '新处置标准',
          适用条件: '值班收到新告警',
          核心结论: '先确认影响面再处置。',
          应做: ['确认影响面'],
          不应做: ['直接重启'],
          来源: 'MR#42',
          责任人: '张三',
          标签: ['告警'],
        }, 'Recording the card.')
      },
      toolCallResponse('loop-call-2', 'kb_gate_check', { id: 'rule-20260818-200', evidence: ['上线 MR#42'] }, 'Checking the gate.'),
      toolCallResponse('loop-call-3', 'kb_team_promote', { id: 'rule-20260818-200', evidence: ['上线 MR#42'] }, 'Promoting to the team library.'),
      toolCallResponse('loop-call-4', 'kb_review', { id: 'rule-20260818-200', approved: true, note: '复核通过' }, 'Reviewing the card.'),
      toolCallResponse('loop-call-5', 'kb_team_commit', { message: '晋升 rule-20260818-200' }, 'Committing the team library.'),
      textResponse('完成。'),
    ])
    const { ctx, workspace } = await harness(adapter, {
      cardTtlDays: 7,
      teamRepoPath: teamRepo,
      teamWriteApproval: false,
      packs: [{ name: '团队告警', tags: ['告警'], library: ['team'] }],
    })

    const agent = ctx.agentLoop.create(SessionId('it-kb-m3'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '沉淀新规则并晋升团队库' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const log = agent.session.events
    // The team pack injected the seeded ready card at session start.
    const injected = log.filter(event => event.type === 'kb/injected')
    expect(injected).toHaveLength(1)
    expect(injected[0]!.data.cardIds).toContain('rule-20260818-100')
    expect(injected[0]!.data.cardIds).not.toContain('rule-20260818-200')

    // The five tool calls all completed without error.
    const results = log.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(5)
    for (const result of results) expect(result.data.message.content[0].isError).toBe(false)

    // The team move and the review transition landed as events.
    const teamJoin = findEvent(log, 'kb/team-join')
    expect(teamJoin.data).toMatchObject({ id: 'rule-20260818-200', status: 'pending' })
    expect(teamJoin.data.path).toContain('rule-20260818-200.md')
    const promotes = log.filter((event): event is Extract<typeof event, { type: 'kb/promote' }> =>
      event.type === 'kb/promote' && event.data.id === 'rule-20260818-200')
    expect(promotes.map(event => event.data.to)).toEqual(['pending', 'ready'])

    // The team repository holds the reviewed card and the commit.
    const teamFile = await readFile(join(teamRepo, 'cards', 'rule-20260818-200.md'), 'utf8')
    expect(teamFile).toContain('状态: ready')
    expect(teamFile).toContain('库: team')
    const { stdout: gitLog } = await execFileAsync('git', ['-C', teamRepo, 'log', '-n 1', '--oneline'])
    expect(gitLog).toContain('晋升 rule-20260818-200')

    // Replay: the log alone reconstructs the whole chain.
    const replayed = Session.create(SessionId('it-kb-m3-replay'), log)
    expect(kbFold(replayed.events)).toBe(kbFold(log))
    const replayJoin = replayed.events.find(event => event.type === 'kb/team-join')
    expect(replayJoin!.data).toEqual(teamJoin.data)
    const replayInjected = replayed.events.filter(event => event.type === 'kb/injected')
    expect(replayInjected).toHaveLength(1)
  })
})
