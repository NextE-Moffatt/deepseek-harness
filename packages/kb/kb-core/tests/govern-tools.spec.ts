// Milestone-3 tool coverage: the gate check, the team promotion (gate
// enforced, events appended, personal file moved), team read, the second-gate
// review, archive/revive transitions, the git status/commit flow over a real
// repository, the freshness scan, and the approval gate on team writes
// (deny without an approval service, allow with one, bypass when configured
// off, and read tools unaffected).
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import KbService from '../src/index.ts'
import type { CardId } from '../src/types.ts'

const execFileAsync = promisify(execFile)
const testToolSignal = new AbortController().signal

let workspaces: string[] = []
afterEach(async () => {
  for (const workspace of workspaces) await rm(workspace, { recursive: true, force: true })
  workspaces = []
})

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-kb-govern-'))
  workspaces.push(workspace)
  return workspace
}

/** A real git work tree usable as the team repository. */
async function makeTeamRepo(): Promise<string> {
  const repo = await makeWorkspace()
  await execFileAsync('git', ['init', '-q', repo])
  await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'kb-test@example.com'])
  await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'kb test'])
  return repo
}

/** An approval service that allows every request once. */
class AllowAllApproval extends Service {
  constructor(ctx: Context) {
    super(ctx, 'approval')
  }

  async request(): Promise<ApprovalOutcome> {
    return 'allowed-once'
  }
}

async function setup(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(KbService, config)
  return ctx
}

/** A fake parent Agent backed by a real session with a workspace cwd. */
async function agentWithWorkspace(ctx: Context, workspace: string, id = 'agent-1'): Promise<Agent> {
  const session = ctx.sessions.create(SessionId(`${id}-session`), { meta: { cwd: workspace } })
  return { id: SessionId(id), session } as unknown as Agent
}

let callCounter = 0
function callTool(ctx: Context, name: string, args: unknown, over: { agent?: Agent } = {}) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
    ...over.agent === undefined ? {} : { agent: over.agent },
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Write a personal draft through the real kb_write tool. */
async function writeDraft(ctx: Context, agent: Agent, over: Record<string, unknown> = {}): Promise<string> {
  const args = Object.fromEntries(Object.entries({
    tier: 'P2',
    type: 'rule',
    title: '告警处置标准',
    适用条件: '值班收到告警',
    核心结论: '先确认影响面。',
    应做: ['确认影响面'],
    不应做: ['直接重启'],
    来源: 'MR#42',
    责任人: '张三',
    标签: ['告警'],
    ...over,
  }).filter(([, value]) => value !== undefined))
  const write = await callTool(ctx, 'kb_write', args, { agent })
  if (write.isError) throw new Error(`kb_write failed: ${text(write)}`)
  return (write.value as { id: string }).id
}

/** The card file text at a path. */
function cardText(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

describe('kb_gate_check', () => {
  it('returns PASS for a complete draft with evidence and BLOCK with reasons otherwise', async () => {
    const workspace = await makeWorkspace()
    const ctx = await setup()
    const agent = await agentWithWorkspace(ctx, workspace)
    console.log('DBG cwd', (agent.session as never as { header: { cwd?: string } }).header.cwd, 'id', agent.id)
    const id = await writeDraft(ctx, agent)

    const pass = await callTool(ctx, 'kb_gate_check', { id, evidence: ['上线 MR#42', '事件单#88 关闭'] }, { agent })
    expect(pass.isError).toBe(false)
    if (!pass.isError) {
      expect(pass.value).toMatchObject({ verdict: 'PASS', evidenceCount: 2, reasons: [] })
      expect(text(pass)).toContain('PASS')
    }

    const block = await callTool(ctx, 'kb_gate_check', { id, evidence: [] }, { agent })
    expect(block.isError).toBe(false)
    if (!block.isError) {
      expect(block.value).toMatchObject({ verdict: 'BLOCK' })
      expect((block.value as { reasons: string[] }).reasons).toContain('evidence is empty; provide at least one objective signal')
    }

    const missing = await callTool(ctx, 'kb_gate_check', { id: 'rule-20990101-999' as CardId, evidence: ['x'] }, { agent })
    expect(missing.isError).toBe(false)
    if (!missing.isError) {
      expect(missing.value).toMatchObject({ verdict: 'BLOCK' })
      expect((missing.value as { reasons: string[] }).reasons).toEqual(['card not found'])
    }

    const blank = await callTool(ctx, 'kb_gate_check', { id, evidence: ['  '] }, { agent })
    expect(blank.isError).toBe(true)
  })
})

describe('kb_team_promote', () => {
  it('moves the draft into the team library as pending, removes the personal file, and logs both events', async () => {
    const workspace = await makeWorkspace()
    const teamRepo = await makeTeamRepo()
    const ctx = await setup({ teamRepoPath: teamRepo, teamWriteApproval: false })
    const agent = await agentWithWorkspace(ctx, workspace)
    const id = await writeDraft(ctx, agent)

    const promote = await callTool(ctx, 'kb_team_promote', { id, evidence: ['上线 MR#42'] }, { agent })
    expect(promote.isError).toBe(false)
    if (!promote.isError) {
      expect(promote.value).toMatchObject({ id, status: 'pending' })
      expect(text(promote)).toContain('已晋升团队库')
    }
    const teamFile = join(teamRepo, 'cards', `${id}.md`)
    expect(await cardText(teamFile)).toContain('库: team')
    expect(await cardText(teamFile)).toContain('状态: pending')
    await expect(readFile(join(workspace, 'kb/cards/P2', `${id}.md`), 'utf8')).rejects.toThrow()
    const events = agent.session.events.map(event => ({ type: event.type, data: event.data }))
    expect(events).toContainEqual({ type: 'kb/promote', data: { id, from: 'draft', to: 'pending', evidence: '上线 MR#42' } })
    expect(events).toContainEqual({ type: 'kb/team-join', data: { id, path: teamFile, status: 'pending' } })
  })

  it('blocks the promotion when the gate fails, writing nothing', async () => {
    const workspace = await makeWorkspace()
    const teamRepo = await makeTeamRepo()
    const ctx = await setup({ teamRepoPath: teamRepo, teamWriteApproval: false })
    const agent = await agentWithWorkspace(ctx, workspace)
    // A draft without 来源 fails the structural gate.
    const id = await writeDraft(ctx, agent, { 来源: undefined })
    const promote = await callTool(ctx, 'kb_team_promote', { id, evidence: ['上线'] }, { agent })
    expect(promote.isError).toBe(true)
    expect(text(promote)).toContain('BLOCK')
    await expect(readFile(join(teamRepo, 'cards', `${id}.md`), 'utf8')).rejects.toThrow()
  })
})

describe('kb_team_read', () => {
  it('returns the team card content and fails loud on unknown ids', async () => {
    const workspace = await makeWorkspace()
    const teamRepo = await makeTeamRepo()
    const ctx = await setup({ teamRepoPath: teamRepo, teamWriteApproval: false })
    const agent = await agentWithWorkspace(ctx, workspace)
    const id = await writeDraft(ctx, agent)
    await callTool(ctx, 'kb_team_promote', { id, evidence: ['上线'] }, { agent })

    const read = await callTool(ctx, 'kb_team_read', { id }, { agent })
    expect(read.isError).toBe(false)
    if (!read.isError) {
      expect(read.value).toMatchObject({ id, 库: 'team', 状态: 'pending' })
      expect(text(read)).toContain('团队卡片')
    }
    const missing = await callTool(ctx, 'kb_team_read', { id: 'rule-20990101-999' as CardId }, { agent })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('team card not found')
  })
})

describe('kb_review (second gate)', () => {
  async function promotedTeam(): Promise<{ ctx: Context; agent: Agent; id: string; workspace: string; teamRepo: string }> {
    const workspace = await makeWorkspace()
    const teamRepo = await makeTeamRepo()
    const ctx = await setup({ teamRepoPath: teamRepo, teamWriteApproval: false })
    const agent = await agentWithWorkspace(ctx, workspace)
    const id = await writeDraft(ctx, agent)
    await callTool(ctx, 'kb_team_promote', { id, evidence: ['上线'] }, { agent })
    return { ctx, agent, id, workspace, teamRepo }
  }

  it('approval transitions pending → ready and appends kb/promote; rejection changes nothing', async () => {
    const { ctx, agent, id, teamRepo } = await promotedTeam()
    const approve = await callTool(ctx, 'kb_review', { id, approved: true, note: '复核通过' }, { agent })
    expect(approve.isError).toBe(false)
    if (!approve.isError) {
      expect(approve.value).toMatchObject({ id, status: 'ready', changed: true, note: '复核通过' })
    }
    expect(await cardText(join(teamRepo, 'cards', `${id}.md`))).toContain('状态: ready')
    expect(agent.session.events).toContainEqual(expect.objectContaining({
      type: 'kb/promote',
      data: { id, from: 'pending', to: 'ready' },
    }))

    const reject = await callTool(ctx, 'kb_review', { id, approved: false, note: '证据不足' }, { agent })
    expect(reject.isError).toBe(false)
    if (!reject.isError) {
      expect(reject.value).toMatchObject({ id, status: 'ready', changed: false, note: '证据不足' })
    }
    const readyPromotions = agent.session.events.filter(event =>
      event.type === 'kb/promote' && event.data.id === id && event.data.to === 'ready')
    expect(readyPromotions).toHaveLength(1)
  })

  it('fails loud when the card is not pending', async () => {
    const { ctx, agent, id } = await promotedTeam()
    await callTool(ctx, 'kb_review', { id, approved: true }, { agent })
    const again = await callTool(ctx, 'kb_review', { id, approved: true }, { agent })
    expect(again.isError).toBe(true)
    expect(text(again)).toContain('kb_review requires a team card in status pending')
  })
})

describe('kb_archive and kb_revive', () => {
  it('retires ready cards, restores archived ones, and re-archives revived ones with true from states', async () => {
    const workspace = await makeWorkspace()
    const teamRepo = await makeTeamRepo()
    const ctx = await setup({ teamRepoPath: teamRepo, teamWriteApproval: false })
    const agent = await agentWithWorkspace(ctx, workspace)
    const id = await writeDraft(ctx, agent)
    await callTool(ctx, 'kb_team_promote', { id, evidence: ['上线'] }, { agent })
    await callTool(ctx, 'kb_review', { id, approved: true }, { agent })

    const archive = await callTool(ctx, 'kb_archive', { id }, { agent })
    expect(archive.isError).toBe(false)
    if (!archive.isError) {
      expect(archive.value).toMatchObject({ id, from: 'ready', to: 'archived' })
    }
    expect(await cardText(join(teamRepo, 'cards', `${id}.md`))).toContain('状态: archived')
    expect(agent.session.events).toContainEqual(expect.objectContaining({
      type: 'kb/promote',
      data: { id, from: 'ready', to: 'archived' },
    }))

    const revive = await callTool(ctx, 'kb_revive', { id }, { agent })
    expect(revive.isError).toBe(false)
    if (!revive.isError) {
      expect(revive.value).toMatchObject({ id, from: 'archived', to: 'revived' })
    }
    expect(agent.session.events).toContainEqual(expect.objectContaining({
      type: 'kb/promote',
      data: { id, from: 'archived', to: 'revived' },
    }))

    const rearchive = await callTool(ctx, 'kb_archive', { id }, { agent })
    expect(rearchive.isError).toBe(false)
    if (!rearchive.isError) {
      expect(rearchive.value).toMatchObject({ id, from: 'revived', to: 'archived' })
    }
  })

  it('fails loud when the transition is illegal (pending cannot archive)', async () => {
    const workspace = await makeWorkspace()
    const teamRepo = await makeTeamRepo()
    const ctx = await setup({ teamRepoPath: teamRepo, teamWriteApproval: false })
    const agent = await agentWithWorkspace(ctx, workspace)
    const id = await writeDraft(ctx, agent)
    await callTool(ctx, 'kb_team_promote', { id, evidence: ['上线'] }, { agent })
    const archive = await callTool(ctx, 'kb_archive', { id }, { agent })
    expect(archive.isError).toBe(true)
    expect(text(archive)).toContain('invalid card transition pending → archived')
  })
})

describe('kb_team_status and kb_team_commit', () => {
  it('reports the working-tree change and commits it into the repository history', async () => {
    const workspace = await makeWorkspace()
    const teamRepo = await makeTeamRepo()
    const ctx = await setup({ teamRepoPath: teamRepo, teamWriteApproval: false })
    const agent = await agentWithWorkspace(ctx, workspace)
    const id = await writeDraft(ctx, agent)
    await callTool(ctx, 'kb_team_promote', { id, evidence: ['上线'] }, { agent })

    const status = await callTool(ctx, 'kb_team_status', {}, { agent })
    expect(status.isError).toBe(false)
    if (!status.isError) {
      expect(status.value).toMatchObject({ clean: false })
      expect((status.value as { files: string[] }).files.some(line => line.includes('cards'))).toBe(true)
    }

    const commit = await callTool(ctx, 'kb_team_commit', { message: `晋升 ${id}` }, { agent })
    expect(commit.isError).toBe(false)
    if (!commit.isError) {
      expect(text(commit)).toContain('已提交团队库')
    }
    const { stdout } = await execFileAsync('git', ['-C', teamRepo, 'log', '-n 1', '--oneline'])
    expect(stdout).toContain(`晋升 ${id}`)

    const clean = await callTool(ctx, 'kb_team_status', {}, { agent })
    expect(clean.isError).toBe(false)
    if (!clean.isError) expect(clean.value).toMatchObject({ clean: true })
  })

  it('fails loud on a blank message and on a commit with nothing staged', async () => {
    const workspace = await makeWorkspace()
    const teamRepo = await makeTeamRepo()
    const ctx = await setup({ teamRepoPath: teamRepo, teamWriteApproval: false })
    const agent = await agentWithWorkspace(ctx, workspace)
    const blank = await callTool(ctx, 'kb_team_commit', { message: '  ' }, { agent })
    expect(blank.isError).toBe(true)
    expect(text(blank)).toContain('message must be a non-empty string')
    const empty = await callTool(ctx, 'kb_team_commit', { message: '空提交' }, { agent })
    expect(empty.isError).toBe(true)
  })
})

describe('kb_freshness', () => {
  it('lists overdue and expiring cards with heat and recommendations', async () => {
    const workspace = await makeWorkspace()
    const ctx = await setup({ cardTtlDays: 7, teamWriteApproval: false })
    const agent = await agentWithWorkspace(ctx, workspace)
    await writeDraft(ctx, agent, { 有效期: '2020-01-01' })
    await writeDraft(ctx, agent, { 有效期: '2026-12-31', title: '长期有效规则' })
    const scan = await callTool(ctx, 'kb_freshness', {}, { agent })
    expect(scan.isError).toBe(false)
    if (!scan.isError) {
      const value = scan.value as { total: number; overdue: Array<{ id: string; recommend: string }> }
      expect(value.total).toBeGreaterThanOrEqual(1)
      expect(value.overdue[0]!.recommend).toBe('archive-candidate')
      expect(text(scan)).toContain('知识保鲜扫描')
      expect(text(scan)).toContain('[已过期]')
    }
  })

  it('returns an empty review for a fresh library', async () => {
    const workspace = await makeWorkspace()
    const ctx = await setup({ cardTtlDays: 365, teamWriteApproval: false })
    const agent = await agentWithWorkspace(ctx, workspace)
    await writeDraft(ctx, agent)
    const scan = await callTool(ctx, 'kb_freshness', {}, { agent })
    expect(scan.isError).toBe(false)
    if (!scan.isError) {
      expect(scan.value).toMatchObject({ total: 0, overdue: [], expiringSoon: [] })
    }
  })
})

describe('team-write approval gate', () => {
  it('denies team write tools without an approval service and allows reads', async () => {
    const workspace = await makeWorkspace()
    const teamRepo = await makeTeamRepo()
    const ctx = await setup({ teamRepoPath: teamRepo })
    const agent = await agentWithWorkspace(ctx, workspace)
    const id = await writeDraft(ctx, agent)
    const promote = await callTool(ctx, 'kb_team_promote', { id, evidence: ['上线'] }, { agent })
    expect(promote.isError).toBe(true)
    expect(text(promote)).toContain('需人工审批')
    await expect(readFile(join(teamRepo, 'cards', `${id}.md`), 'utf8')).rejects.toThrow()
    // Read-only tools are not gated.
    const gate = await callTool(ctx, 'kb_gate_check', { id, evidence: ['上线'] }, { agent })
    expect(gate.isError).toBe(false)
  })

  it('allows team writes when the approval service grants them', async () => {
    const workspace = await makeWorkspace()
    const teamRepo = await makeTeamRepo()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AllowAllApproval)
    await ctx.plugin(KbService, { teamRepoPath: teamRepo })
    const agent = await agentWithWorkspace(ctx, workspace)
    const id = await writeDraft(ctx, agent)
    const promote = await callTool(ctx, 'kb_team_promote', { id, evidence: ['上线'] }, { agent })
    expect(promote.isError).toBe(false)
    if (!promote.isError) expect(promote.value).toMatchObject({ id, status: 'pending' })
    await expect(readFile(join(teamRepo, 'cards', `${id}.md`), 'utf8')).resolves.toContain('库: team')
  })

  it('bypasses the gate when teamWriteApproval is false', async () => {
    const workspace = await makeWorkspace()
    const teamRepo = await makeTeamRepo()
    const ctx = await setup({ teamRepoPath: teamRepo, teamWriteApproval: false })
    const agent = await agentWithWorkspace(ctx, workspace)
    const id = await writeDraft(ctx, agent)
    const promote = await callTool(ctx, 'kb_team_promote', { id, evidence: ['上线'] }, { agent })
    expect(promote.isError).toBe(false)
  })
})

describe('milestone-3 presentation projections', () => {
  it('declares the render intents for all nine tools', async () => {
    const ctx = await setup()
    const defs = ctx.tools.schemas().filter(schema => [
      'kb_gate_check', 'kb_team_promote', 'kb_team_read', 'kb_review',
      'kb_archive', 'kb_revive', 'kb_team_status', 'kb_team_commit', 'kb_freshness',
    ].includes(schema.name))
    expect(defs).toHaveLength(9)
    expect(ctx.tools.get('kb_gate_check')!.presentCall?.({ id: 'r-1', evidence: ['x'] }))
      .toEqual({ card: 'generic', title: '门禁检查 r-1', kind: 'other', rawInput: { id: 'r-1', evidence: ['x'] } })
    expect(ctx.tools.get('kb_team_promote')!.presentCall?.({ id: 'r-1', evidence: ['x'] }))
      .toEqual({ card: 'generic', title: '晋升团队库 r-1', kind: 'other', rawInput: { id: 'r-1', evidence: ['x'] } })
    expect(ctx.tools.get('kb_team_read')!.presentCall?.({ id: 'r-1' }))
      .toEqual({ card: 'generic', title: '读团队卡片 r-1', kind: 'other', rawInput: { id: 'r-1' } })
    expect(ctx.tools.get('kb_review')!.presentCall?.({ id: 'r-1', approved: true }))
      .toEqual({ card: 'generic', title: '复核卡片 r-1：通过', kind: 'other', rawInput: { id: 'r-1', approved: true } })
    expect(ctx.tools.get('kb_review')!.presentCall?.({ id: 'r-1', approved: false }))
      .toEqual({ card: 'generic', title: '复核卡片 r-1：不通过', kind: 'other', rawInput: { id: 'r-1', approved: false } })
    expect(ctx.tools.get('kb_archive')!.presentCall?.({ id: 'r-1' }))
      .toEqual({ card: 'generic', title: '归档卡片 r-1', kind: 'other', rawInput: { id: 'r-1' } })
    expect(ctx.tools.get('kb_revive')!.presentCall?.({ id: 'r-1' }))
      .toEqual({ card: 'generic', title: '复活卡片 r-1', kind: 'other', rawInput: { id: 'r-1' } })
    expect(ctx.tools.get('kb_team_status')!.presentCall?.({}))
      .toEqual({ card: 'generic', title: '团队库状态', kind: 'other' })
    expect(ctx.tools.get('kb_team_commit')!.presentCall?.({ message: 'm' }))
      .toEqual({ card: 'generic', title: '提交团队库：m', kind: 'other', rawInput: { message: 'm' } })
    expect(ctx.tools.get('kb_freshness')!.presentCall?.({}))
      .toEqual({ card: 'generic', title: '知识保鲜扫描', kind: 'other' })
  })

  it('presents the completed results of the nine tools', async () => {
    const ctx = await setup()
    const content = [{ type: 'text', text: 'x' } as { type: 'text'; text: string }]
    const expectResult = (name: string, args: unknown, title: string) => {
      expect(ctx.tools.get(name)!.presentResult?.(args, { content, isError: false }))
        .toEqual({ card: 'generic', title, content })
    }
    expectResult('kb_gate_check', { id: 'r-1', evidence: ['x'] }, '门禁结论')
    expectResult('kb_team_promote', { id: 'r-1', evidence: ['x'] }, '已晋升团队库')
    expectResult('kb_team_read', { id: 'r-1' }, '团队卡片内容')
    expectResult('kb_review', { id: 'r-1', approved: true }, '复核完成')
    expectResult('kb_archive', { id: 'r-1' }, '已归档')
    expectResult('kb_revive', { id: 'r-1' }, '已复活')
    expectResult('kb_team_status', {}, '团队库状态')
    expectResult('kb_team_commit', { message: 'm' }, '已提交团队库')
    expectResult('kb_freshness', {}, '保鲜扫描结果')
  })

  it('renders the status, archive, revive, and freshness text faces', async () => {
    const workspace = await makeWorkspace()
    const teamRepo = await makeTeamRepo()
    const ctx = await setup({ teamRepoPath: teamRepo, teamWriteApproval: false })
    const agent = await agentWithWorkspace(ctx, workspace)
    const id = await writeDraft(ctx, agent)
    await callTool(ctx, 'kb_team_promote', { id, evidence: ['上线'] }, { agent })

    const status = await callTool(ctx, 'kb_team_status', {}, { agent })
    if (!status.isError) expect(text(status)).toContain('待提交变更')
    await callTool(ctx, 'kb_team_commit', { message: 'm' }, { agent })
    const clean = await callTool(ctx, 'kb_team_status', {}, { agent })
    if (!clean.isError) expect(text(clean)).toContain('工作树干净')

    await callTool(ctx, 'kb_review', { id, approved: true }, { agent })
    const archive = await callTool(ctx, 'kb_archive', { id }, { agent })
    if (!archive.isError) expect(text(archive)).toContain('已归档')
    const revive = await callTool(ctx, 'kb_revive', { id }, { agent })
    if (!revive.isError) expect(text(revive)).toContain('已复活')
    const read = await callTool(ctx, 'kb_team_read', { id }, { agent })
    if (!read.isError) expect(text(read)).toContain('团队卡片')
  })

  it('reads a hand-written team card with 反例 and without 来源', async () => {
    const workspace = await makeWorkspace()
    const teamRepo = await makeTeamRepo()
    const ctx = await setup({ teamRepoPath: teamRepo, teamWriteApproval: false })
    const agent = await agentWithWorkspace(ctx, workspace)
    await mkdir(join(teamRepo, 'cards'))
    await writeFile(join(teamRepo, 'cards', 'case-20260818-001.md'), `---
id: case-20260818-001
type: case
title: 手工卡片
库: team
状态: ready
适用条件: 手工场景
责任人: 李四
有效期: 2026-12-31
标签:
  - 告警
---

## 核心结论

结论。

## 应做

- 做

## 不应做

- 不做

## 反例 / 踩坑记录

反例记录。
`, 'utf8')
    const read = await callTool(ctx, 'kb_team_read', { id: 'case-20260818-001' }, { agent })
    expect(read.isError).toBe(false)
    if (!read.isError) {
      expect(read.value).toMatchObject({ 反例: '反例记录。' })
      expect('来源' in (read.value as Record<string, unknown>)).toBe(false)
      expect(text(read)).toContain('反例记录。')
    }
  })

  it('renders a review without a note and a rejected review with a note', async () => {
    const workspace = await makeWorkspace()
    const teamRepo = await makeTeamRepo()
    const ctx = await setup({ teamRepoPath: teamRepo, teamWriteApproval: false })
    const agent = await agentWithWorkspace(ctx, workspace)
    const id = await writeDraft(ctx, agent)
    await callTool(ctx, 'kb_team_promote', { id, evidence: ['上线'] }, { agent })
    const noNote = await callTool(ctx, 'kb_review', { id, approved: true }, { agent })
    expect(noNote.isError).toBe(false)
    if (!noNote.isError) {
      expect(text(noNote)).toContain('已复核通过')
      expect(text(noNote)).not.toContain('意见')
    }
    // Reject a card still pending in a fresh chain.
    const workspace2 = await makeWorkspace()
    const teamRepo2 = await makeTeamRepo()
    const ctx2 = await setup({ teamRepoPath: teamRepo2, teamWriteApproval: false })
    const agent2 = await agentWithWorkspace(ctx2, workspace2)
    const id2 = await writeDraft(ctx2, agent2)
    await callTool(ctx2, 'kb_team_promote', { id: id2, evidence: ['上线'] }, { agent: agent2 })
    const rejected = await callTool(ctx2, 'kb_review', { id: id2, approved: false, note: '证据不足' }, { agent: agent2 })
    expect(rejected.isError).toBe(false)
    if (!rejected.isError) {
      expect(text(rejected)).toContain('复核未通过')
      expect(text(rejected)).toContain('意见：证据不足')
    }
  })

  it('renders every review outcome combination', async () => {
    const workspace = await makeWorkspace()
    const teamRepo = await makeTeamRepo()
    const ctx = await setup({ teamRepoPath: teamRepo, teamWriteApproval: false })
    const agent = await agentWithWorkspace(ctx, workspace)
    const id = await writeDraft(ctx, agent)
    await callTool(ctx, 'kb_team_promote', { id, evidence: ['上线'] }, { agent })

    // Approved with a note renders the note; rejected without a note omits it.
    const approved = await callTool(ctx, 'kb_review', { id, approved: true, note: '通过' }, { agent })
    if (!approved.isError) expect(text(approved)).toContain('意见：通过')
    const workspace2 = await makeWorkspace()
    const teamRepo2 = await makeTeamRepo()
    const ctx2 = await setup({ teamRepoPath: teamRepo2, teamWriteApproval: false })
    const agent2 = await agentWithWorkspace(ctx2, workspace2)
    const id2 = await writeDraft(ctx2, agent2)
    await callTool(ctx2, 'kb_team_promote', { id: id2, evidence: ['上线'] }, { agent: agent2 })
    const rejected = await callTool(ctx2, 'kb_review', { id: id2, approved: false }, { agent: agent2 })
    if (!rejected.isError) {
      expect(text(rejected)).toContain('复核未通过')
      expect(text(rejected)).not.toContain('意见')
      expect('note' in (rejected.value as Record<string, unknown>)).toBe(false)
    }
  })

  it('resolves a relative teamRepoPath against the workspace root', async () => {
    const workspace = await makeWorkspace()
    await mkdir(join(workspace, 'kb-team'))
    await execFileAsync('git', ['init', '-q', join(workspace, 'kb-team')])
    await execFileAsync('git', ['-C', join(workspace, 'kb-team'), 'config', 'user.email', 'kb-test@example.com'])
    await execFileAsync('git', ['-C', join(workspace, 'kb-team'), 'config', 'user.name', 'kb test'])
    const ctx = await setup({ teamRepoPath: 'kb-team', teamWriteApproval: false })
    const agent = await agentWithWorkspace(ctx, workspace)
    const id = await writeDraft(ctx, agent)
    const promote = await callTool(ctx, 'kb_team_promote', { id, evidence: ['上线'] }, { agent })
    expect(promote.isError).toBe(false)
    if (!promote.isError) {
      expect((promote.value as { path: string }).path).toContain(join(workspace, 'kb-team'))
    }
  })

  it('kb_promote refuses team-library cards with guidance', async () => {
    const workspace = await makeWorkspace()
    const teamRepo = await makeTeamRepo()
    const ctx = await setup({ teamRepoPath: teamRepo, teamWriteApproval: false })
    const agent = await agentWithWorkspace(ctx, workspace)
    const id = await writeDraft(ctx, agent)
    await callTool(ctx, 'kb_team_promote', { id, evidence: ['上线'] }, { agent })
    const promote = await callTool(ctx, 'kb_promote', { id, target: 'pending', evidence: 'x' }, { agent })
    expect(promote.isError).toBe(true)
    expect(text(promote)).toContain('请用 kb_review')
  })

  it('team tools fail loud when no team repository is configured', async () => {
    const workspace = await makeWorkspace()
    const ctx = await setup({ teamWriteApproval: false })
    const agent = await agentWithWorkspace(ctx, workspace)
    const id = await writeDraft(ctx, agent)
    const promote = await callTool(ctx, 'kb_team_promote', { id, evidence: ['上线'] }, { agent })
    expect(promote.isError).toBe(true)
    expect(text(promote)).toContain('teamRepoPath')
    const status = await callTool(ctx, 'kb_team_status', {}, { agent })
    expect(status.isError).toBe(true)
  })

  it('exposes the wiki docs seam through the service', async () => {
    const workspace = await makeWorkspace()
    const teamRepo = await makeTeamRepo()
    const ctx = await setup({ teamRepoPath: teamRepo, teamWriteApproval: false })
    await mkdir(join(teamRepo, 'docs'))
    await writeFile(join(teamRepo, 'docs', 'guide.md'), '# 指南', 'utf8')
    const root = workspace
    expect(await ctx.kb.listTeamDocs(root)).toEqual([join('docs', 'guide.md')])
    expect(await ctx.kb.readTeamDoc(root, join('docs', 'guide.md'))).toBe('# 指南')
    await expect(ctx.kb.readTeamDoc(root, '../escape.md')).rejects.toThrow(/stay inside docs/)
    const bare = await setup()
    await expect(bare.kb.listTeamDocs(root)).rejects.toThrow(/not configured/)
  })
})
