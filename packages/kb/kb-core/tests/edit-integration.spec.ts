/**
 * Service-level coverage of `KbService.editCard`: personal and team edits
 * against real stores (a git work tree for the team library), the optimistic
 * conflict guard, the team approval gate, the no-op path, and the failure
 * paths. The workbench's `kb/edit` event append is covered by the kb-web
 * spec and the loader-composition chain.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionStore from '@deepseek-ai/dsh-session'
import KbService from '../src/index.ts'
import type { CardId } from '../src/types.ts'

const execFileAsync = promisify(execFile)

const CARD_ID = 'rule-20260818-001' as CardId

let workspaces: string[] = []
let teamRepos: string[] = []
afterEach(async () => {
  for (const dir of [...workspaces, ...teamRepos]) await rm(dir, { recursive: true, force: true })
  workspaces = []
  teamRepos = []
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  workspaces.push(dir)
  return dir
}

async function setup(config: Record<string, unknown> = {}): Promise<{ ctx: Context; workspace: string }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(KbService, config)
  const workspace = await tempDir('dsh-kb-edit-')
  return { ctx, workspace }
}

async function writeDraft(ctx: Context, workspace: string, over: Record<string, unknown> = {}): Promise<void> {
  await ctx.kb.writeCard(workspace, {
    tier: 'P2', id: CARD_ID, type: 'rule', title: '告警处置标准',
    适用条件: '值班收到告警', 核心结论: '先确认影响面。',
    应做: ['确认影响面'], 不应做: ['直接重启'],
    来源: 'MR#42', 责任人: '张三', 有效期: '2026-12-31', 标签: ['告警'],
    ...over,
  })
}

describe('kb.editCard', () => {
  it('edits a personal card in place and reports the changed fields', async () => {
    const { ctx, workspace } = await setup()
    await writeDraft(ctx, workspace)
    const result = await ctx.kb.editCard(workspace, CARD_ID, { title: '新标题', 标签: ['告警', '值班'] })
    expect(result).toMatchObject({ library: 'personal', tier: 'P2', fields: ['title', '标签'] })
    expect(result.card).toMatchObject({ id: CARD_ID, title: '新标题', 标签: ['告警', '值班'], 状态: 'draft' })
    const onDisk = await readFile(result.path, 'utf8')
    expect(onDisk).toContain('title: 新标题')
    expect(onDisk).toContain('状态: draft')
  })

  it('clears an optional field with an empty string', async () => {
    const { ctx, workspace } = await setup()
    await writeDraft(ctx, workspace)
    const result = await ctx.kb.editCard(workspace, CARD_ID, { 来源: '' })
    expect(result.fields).toEqual(['来源'])
    expect(result.card.来源).toBeUndefined()
    expect(await readFile(result.path, 'utf8')).not.toContain('来源')
  })

  it('no-ops without a write when the patch changes nothing', async () => {
    const { ctx, workspace } = await setup()
    await writeDraft(ctx, workspace)
    const before = await readFile(join(workspace, 'kb/cards/P2', `${CARD_ID}.md`), 'utf8')
    const result = await ctx.kb.editCard(workspace, CARD_ID, { title: '告警处置标准' })
    expect(result.fields).toEqual([])
    expect(result.library).toBe('personal')
    expect(await readFile(join(workspace, 'kb/cards/P2', `${CARD_ID}.md`), 'utf8')).toBe(before)
  })

  it('fails loud when the on-disk identity differs from the expected one (conflict)', async () => {
    const { ctx, workspace } = await setup()
    await writeDraft(ctx, workspace)
    await expect(ctx.kb.editCard(workspace, CARD_ID, { title: '并发标题' }, { expected: { mtime: 1, size: 1 } }))
      .rejects.toThrow(/已被其他会话修改/)
    // A matching expected identity passes.
    const info = await ctx.kb.readCard(workspace, CARD_ID)
    await expect(ctx.kb.editCard(workspace, CARD_ID, { title: '并发标题' }, { expected: { mtime: info.mtime, size: info.size } }))
      .resolves.toMatchObject({ fields: ['title'] })
  })

  it('fails loud on an unknown card and an invalid patch', async () => {
    const { ctx, workspace } = await setup()
    await expect(ctx.kb.editCard(workspace, 'missing-1' as CardId, { title: 'x' })).rejects.toThrow(/card not found/)
    await writeDraft(ctx, workspace)
    await expect(ctx.kb.editCard(workspace, CARD_ID, { title: '  ' })).rejects.toThrow(/non-empty string/)
    await expect(ctx.kb.editCard(workspace, CARD_ID, { 有效期: 'not-a-date' })).rejects.toThrow(/YYYY-MM-DD/)
    await expect(ctx.kb.editCard(workspace, CARD_ID, { 状态: 'ready' } as never)).rejects.toThrow(/unknown field/)
  })
})

describe('kb.editCard team library', () => {
  async function setupTeam(config: Record<string, unknown> = {}): Promise<{ ctx: Context; workspace: string; teamRepo: string }> {
    const teamRepo = await mkdtemp(join(tmpdir(), 'dsh-kb-edit-team-'))
    teamRepos.push(teamRepo)
    await execFileAsync('git', ['init', '-q', teamRepo])
    const { ctx, workspace } = await setup({ teamRepoPath: teamRepo, ...config })
    // A real team card through the first gate.
    await writeDraft(ctx, workspace)
    await ctx.kb.promoteToTeam(workspace, CARD_ID, ['评审'])
    return { ctx, workspace, teamRepo }
  }

  it('edits a team card in place with explicit approval under the default gate', async () => {
    const { ctx, workspace } = await setupTeam()
    const result = await ctx.kb.editCard(workspace, CARD_ID, { title: '团队新标题' }, { approved: true })
    expect(result).toMatchObject({ library: 'team', tier: 'team', fields: ['title'] })
    const onDisk = await readFile(result.path, 'utf8')
    expect(onDisk).toContain('title: 团队新标题')
    expect(onDisk).toContain('库: team')
  })

  it('refuses a team edit without approval when the gate is set', async () => {
    const { ctx, workspace } = await setupTeam()
    await expect(ctx.kb.editCard(workspace, CARD_ID, { title: '无审批标题' }))
      .rejects.toThrow(/需经审批/)
  })

  it('no-ops a team edit without approval when nothing changes (the no-op path skips the gate)', async () => {
    const { ctx, workspace } = await setupTeam()
    const result = await ctx.kb.editCard(workspace, CARD_ID, { title: '告警处置标准' })
    expect(result).toMatchObject({ library: 'team', tier: 'team', fields: [] })
  })

  it('allows a team edit without approval when the gate is disabled', async () => {
    const { ctx, workspace } = await setupTeam({ teamWriteApproval: false })
    await expect(ctx.kb.editCard(workspace, CARD_ID, { title: '开放标题' }))
      .resolves.toMatchObject({ library: 'team', fields: ['title'] })
  })
})
