/**
 * Real-composition acceptance chain for `@deepseek-ai/dsh-kb-web`: boots a
 * test-only cordis.yml through the real Loader with kb-core and kb-web
 * mounted, then drives the workbench seam in a real workspace — write cards,
 * seed a blind spot, and run the overview plus every lifecycle action —
 * asserting the card files, the `kb/*` session events, and the log replay.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import KbCore from '@deepseek-ai/dsh-kb-core'
import type { CardId, KbService } from '@deepseek-ai/dsh-kb-core'
import KbWeb from '@deepseek-ai/dsh-kb-web'
import type { KbWorkbenchService } from '@deepseek-ai/dsh-kb-web'

const execFileAsync = promisify(execFile)

let root: string | undefined
let workspace: string | undefined
let teamRepo: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const dir of [root, workspace, teamRepo]) {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
  root = undefined
  workspace = undefined
  teamRepo = undefined
})

/** Wait until the fire-and-forget heat ledger append has landed on disk. */
async function waitForLedger(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await readFile(path, 'utf8')
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  throw new Error('heat ledger was not written')
}

async function boot(configLines: readonly string[] = []): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-kb-web-loader-'))
  workspace = await mkdtemp(join(tmpdir(), 'dsh-kb-web-workspace-'))
  teamRepo = await mkdtemp(join(tmpdir(), 'dsh-kb-web-team-'))
  await execFileAsync('git', ['init', '-q', teamRepo])
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-kb-core'",
    '  config:',
    `    teamRepoPath: ${teamRepo}`,
    "- name: '@deepseek-ai/dsh-kb-web'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-kb-core', KbCore],
    ['@deepseek-ai/dsh-kb-web', KbWeb],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected import ${specifier}`)
      return module as never
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/** A workspace session carrying the given appended events. */
function sessionWith(ctx: Context, id: string, cwd: string, append: (session: Session) => void): Session {
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd } })
  append(session)
  return session
}

describe('kb workbench through the Loader composition', () => {
  it('exposes the Remote service, projects the merged overview, and drives every action with logged events', async () => {
    const ctx = await boot()
    const kb = ctx.get('kb') as KbService
    const service = ctx.get('kbWorkbench') as KbWorkbenchService
    expect(service.typertRemote.namespace).toBe('kbWorkbench')

    // A real draft card that will enter the freshness review as overdue.
    await kb.writeCard(workspace!, {
      tier: 'P2', id: 'rule-20260801-001' as CardId, type: 'rule', title: '过期规则',
      适用条件: '任何会话', 核心结论: '结论', 应做: ['做'], 不应做: ['不做'],
      责任人: '本人', 有效期: '2026-08-01', 标签: ['kb'],
    })
    // A second draft that moves through the team gate and the second gate.
    await kb.writeCard(workspace!, {
      tier: 'P2', id: 'rule-20260801-002' as CardId, type: 'rule', title: '待复核规则',
      适用条件: '任何会话', 核心结论: '结论', 应做: ['做'], 不应做: ['不做'],
      来源: 'https://example.com/MR-2', 责任人: '本人', 有效期: '2099-01-01', 标签: ['kb'],
    })

    // A blind spot: a workspace session that consumed knowledge but wrote no card.
    sessionWith(ctx, 'blind', workspace!, (session) => {
      session.append('kb/injected', {
        pack: '测试包', cardIds: ['rule-20260801-001' as CardId], sections: [{ name: 'rule-20260801-001', text: '内容' }],
      })
    })
    await waitForLedger(join(workspace!, 'kb', '.kb-heat.jsonl'))

    // The workbench session: the human surface the actions log into.
    const workbench = ctx.sessions.create(SessionId('workbench'), { meta: { cwd: workspace! } })

    // Overview: the overdue card is flagged, the blind spot is listed, and the
    // flywheel metrics project from the heat ledger and the session logs.
    const today = '2026-08-19'
    const overview = await service.overview(workbench, today)
    expect(overview.scanDate).toBe(today)
    expect(overview.freshness.overdue.map(entry => entry.id)).toContain('rule-20260801-001')
    expect(overview.blindSpots).toHaveLength(1)
    expect(overview.blindSpots[0]).toMatchObject({ sessionId: SessionId('blind'), consumed: ['rule-20260801-001'] })
    expect(overview.metrics.pendingReview).toBe(1)
    expect(overview.metrics.blindSpots).toBe(1)
    expect(overview.metrics.injections).toBe(1)
    expect(overview.metrics.topHeat).toHaveLength(1)
    expect(overview.metrics.topHeat[0]).toMatchObject({ cardId: 'rule-20260801-001', title: '过期规则', count: 1 })

    // Promote the overdue personal draft toward pending; the card file changes
    // and the workbench session logs kb/promote.
    const promoted = await service.promote(workbench, 'rule-20260801-001', 'pending')
    expect(promoted.to).toBe('pending')
    const onDisk = await readFile(promoted.path, 'utf8')
    expect(onDisk).toContain('状态: pending')
    expect(workbench.events.find(event => event.type === 'kb/promote')?.data).toEqual({
      id: 'rule-20260801-001', from: 'draft', to: 'pending',
    })

    // The model path moves the second draft into the team library (the first
    // gate stays a kb_team_promote concern; the workbench does not own it).
    const joined = await kb.promoteToTeam(workspace!, 'rule-20260801-002' as CardId, ['评审'])
    expect(joined.card.库).toBe('team')

    // Review approval moves the team card into the reference pool and logs.
    const reviewed = await service.review(workbench, 'rule-20260801-002', true)
    expect(reviewed.changed).toBe(true)
    // Archive then revive the ready team card, logging each transition.
    const archived = await service.archive(workbench, 'rule-20260801-002')
    expect(archived.card.状态).toBe('archived')
    expect(archived.from).toBe('ready')
    const revived = await service.revive(workbench, 'rule-20260801-002')
    expect(revived.card.状态).toBe('revived')
    expect(revived.from).toBe('archived')

    // The card detail resolves the team card in its revived state.
    const view = await service.card(workbench, 'rule-20260801-002')
    expect(view.library).toBe('team')
    expect(view.card.状态).toBe('revived')

    // The session log alone rebuilds the whole promotion chain.
    const promotions = workbench.events.filter(event => event.type === 'kb/promote').map(event => event.data)
    expect(promotions).toEqual([
      { id: 'rule-20260801-001', from: 'draft', to: 'pending' },
      { id: 'rule-20260801-002', from: 'pending', to: 'ready' },
      { id: 'rule-20260801-002', from: 'ready', to: 'archived' },
      { id: 'rule-20260801-002', from: 'archived', to: 'revived' },
    ])

    // The read-only overview never touched the recap checkpoint.
    await expect(readFile(join(workspace!, 'kb', '.kb-recap.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses invalid config at load', async () => {
    const ctx = new Context()
    context = ctx
    root = await mkdtemp(join(tmpdir(), 'dsh-kb-web-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-kb-core'",
      "- name: '@deepseek-ai/dsh-kb-web'",
      '  config:',
      '    blindSpotLimit: 0',
      '',
    ].join('\n'))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-kb-core', KbCore],
      ['@deepseek-ai/dsh-kb-web', KbWeb],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        const module = modules.get(specifier)
        if (module === undefined) throw new Error(`unexpected import ${specifier}`)
        return module as never
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    const load = ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await expect(load).rejects.toThrow(/blindSpotLimit must be a positive integer/)
  })
})
