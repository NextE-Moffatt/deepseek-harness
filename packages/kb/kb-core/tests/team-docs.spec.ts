/**
 * Service-level coverage of `KbService.writeTeamDoc` / `removeTeamDoc` /
 * `teamDocInfo` against a real team git work tree: the overwrite-only
 * contract, the optimistic conflict guard, the team approval gate, the
 * escape and `.md` guards, and the loud failures. The workbench's
 * `kb/doc-write` / `kb/doc-remove` event appends are covered by the kb-web
 * spec and the loader-composition chain.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionStore from '@deepseek-ai/dsh-session'
import KbService from '../src/index.ts'

const execFileAsync = promisify(execFile)

const DOC = join('docs', 'architecture.md')
const NESTED_DOC = join('docs', '新人专区', 'onboarding.md')

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

/** A real git work tree with one seeded wiki document. */
async function setupTeam(config: Record<string, unknown> = {}): Promise<{ ctx: Context; workspace: string; teamRepo: string }> {
  const teamRepo = await mkdtemp(join(tmpdir(), 'dsh-kb-doc-team-'))
  teamRepos.push(teamRepo)
  await execFileAsync('git', ['init', '-q', teamRepo])
  await mkdir(join(teamRepo, 'docs', '新人专区'), { recursive: true })
  await writeFile(join(teamRepo, 'docs', 'architecture.md'), '# 架构说明', 'utf8')
  await writeFile(join(teamRepo, 'docs', '新人专区', 'onboarding.md'), '# 新人指南', 'utf8')
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(KbService, { teamRepoPath: teamRepo, ...config })
  const workspace = await tempDir('dsh-kb-doc-ws-')
  return { ctx, workspace, teamRepo }
}

describe('kb.writeTeamDoc', () => {
  it('overwrites an existing doc in place and reports the repository-relative path and identity', async () => {
    const { ctx, workspace, teamRepo } = await setupTeam()
    const result = await ctx.kb.writeTeamDoc(workspace, DOC, '# 更新的架构说明', { approved: true })
    expect(result.path).toBe(DOC)
    expect(result.size).toBe(Buffer.byteLength('# 更新的架构说明'))
    expect(result.mtime).toBeGreaterThan(0)
    expect(await readFile(join(teamRepo, 'docs', 'architecture.md'), 'utf8')).toBe('# 更新的架构说明')
    // The identity the Remote serves comes from the same stat face.
    const info = await ctx.kb.teamDocInfo(workspace, DOC)
    expect(info).toEqual({ path: DOC, mtime: result.mtime, size: result.size })
    // Nested paths create their parent directories.
    const nested = await ctx.kb.writeTeamDoc(workspace, NESTED_DOC, '# 更新的新人指南', { approved: true })
    expect(nested.path).toBe(NESTED_DOC)
    expect(await readFile(join(teamRepo, 'docs', '新人专区', 'onboarding.md'), 'utf8')).toBe('# 更新的新人指南')
  })

  it('fails loud on empty content, a missing doc, an escaping path, and a non-.md path', async () => {
    const { ctx, workspace } = await setupTeam()
    await expect(ctx.kb.writeTeamDoc(workspace, DOC, '   ')).rejects.toThrow(/non-empty string/)
    await expect(ctx.kb.writeTeamDoc(workspace, join('docs', 'missing.md'), 'x')).rejects.toThrow()
    await expect(ctx.kb.writeTeamDoc(workspace, 'cards/rule-1.md', 'x')).rejects.toThrow(/stay inside docs/)
    await expect(ctx.kb.writeTeamDoc(workspace, join('docs', 'notes.txt'), 'x')).rejects.toThrow(/end in \.md/)
  })

  it('guards the overwrite with the expected file identity', async () => {
    const { ctx, workspace } = await setupTeam()
    await expect(ctx.kb.writeTeamDoc(workspace, DOC, '并发内容', { expected: { mtime: 1, size: 1 }, approved: true }))
      .rejects.toThrow(/已被其他会话修改/)
    const info = await ctx.kb.teamDocInfo(workspace, DOC)
    const result = await ctx.kb.writeTeamDoc(workspace, DOC, '并发内容', { expected: info, approved: true })
    expect(result.size).toBe(Buffer.byteLength('并发内容'))
  })

  it('enforces the team approval gate and honors a disabled gate', async () => {
    const { ctx, workspace } = await setupTeam()
    await expect(ctx.kb.writeTeamDoc(workspace, DOC, '无审批')).rejects.toThrow(/需经审批/)
    await expect(ctx.kb.writeTeamDoc(workspace, DOC, '有审批', { approved: true }))
      .resolves.toMatchObject({ path: DOC })
    const open = await setupTeam({ teamWriteApproval: false })
    await expect(open.ctx.kb.writeTeamDoc(open.workspace, DOC, '开放写'))
      .resolves.toMatchObject({ path: DOC })
  })
})

describe('kb.removeTeamDoc', () => {
  it('removes the doc and fails loud when it is already gone', async () => {
    const { ctx, workspace, teamRepo } = await setupTeam()
    await expect(ctx.kb.removeTeamDoc(workspace, DOC, { approved: true }))
      .resolves.toEqual({ path: DOC })
    expect(await ctx.kb.listTeamDocs(workspace)).toEqual([NESTED_DOC])
    await expect(ctx.kb.removeTeamDoc(workspace, DOC, { approved: true })).rejects.toThrow()
    expect(await readFile(join(teamRepo, 'docs', '新人专区', 'onboarding.md'), 'utf8')).toBe('# 新人指南')
  })

  it('enforces the approval gate and the escape/.md guards', async () => {
    const { ctx, workspace } = await setupTeam()
    await expect(ctx.kb.removeTeamDoc(workspace, DOC)).rejects.toThrow(/需经审批/)
    await expect(ctx.kb.removeTeamDoc(workspace, 'cards/rule-1.md', { approved: true })).rejects.toThrow(/stay inside docs/)
    await expect(ctx.kb.removeTeamDoc(workspace, join('docs', 'notes.txt'), { approved: true })).rejects.toThrow(/end in \.md/)
    const open = await setupTeam({ teamWriteApproval: false })
    await expect(open.ctx.kb.removeTeamDoc(open.workspace, DOC)).resolves.toEqual({ path: DOC })
  })
})

describe('kb.teamDocInfo', () => {
  it('fails loud when the team library is not configured', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(KbService)
    const workspace = await tempDir('dsh-kb-doc-no-team-')
    await expect(ctx.kb.writeTeamDoc(workspace, DOC, 'x')).rejects.toThrow(/not configured/)
    await expect(ctx.kb.teamDocInfo(workspace, DOC)).rejects.toThrow(/not configured/)
  })
})
