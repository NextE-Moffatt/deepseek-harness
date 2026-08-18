import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import KbService from '../src/index.ts'
import type { CardId } from '../src/types.ts'

const testToolSignal = new AbortController().signal

let workspaces: string[] = []
afterEach(async () => {
  for (const workspace of workspaces) await rm(workspace, { recursive: true, force: true })
  workspaces = []
})

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-kb-tools-'))
  workspaces.push(workspace)
  return workspace
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

function writeArgs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tier: 'P2',
    type: 'rule',
    title: '处置标准：XX 类事件怎么办',
    适用条件: '值班时收到 XX 类告警',
    核心结论: '按统一流程处置。',
    应做: ['先确认影响面'],
    不应做: ['不要直接重启'],
    责任人: '张三',
    ...over,
  }
}

describe('tool registration', () => {
  it('registers kb_write, kb_read, kb_search, kb_promote with the card-vocabulary schema', async () => {
    const ctx = await setup()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toEqual([
      'kb_write', 'kb_read', 'kb_search', 'kb_promote',
      'kb_gate_check', 'kb_team_promote', 'kb_team_read', 'kb_review',
      'kb_archive', 'kb_revive', 'kb_team_status', 'kb_team_commit', 'kb_freshness',
    ])
    const write = ctx.tools.schemas().find(schema => schema.name === 'kb_write')!
    const props = (write.parameters as { properties: Record<string, unknown> }).properties
    expect(Object.keys(props).sort()).toEqual([
      'id', 'title', 'type', 'tier', '适用条件', '核心结论', '应做', '不应做', '来源', '责任人', '有效期', '标签', '反例',
    ].sort())
    const search = ctx.tools.schemas().find(schema => schema.name === 'kb_search')!
    expect((search.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty('query')
  })

  it('embeds the configured cardTtlDays in the kb_write description (real configurability)', async () => {
    const ctx = await setup({ cardTtlDays: 7 })
    const description = ctx.tools.schemas().find(schema => schema.name === 'kb_write')!.description
    expect(description).toContain('cardTtlDays')
    expect(description).toContain('7')
  })
})

describe('kb_write', () => {
  it('writes a draft card file, returns the canonical value, and appends kb/write', async () => {
    const ctx = await setup({ cardTtlDays: 30 })
    const workspace = await makeWorkspace()
    const agent = await agentWithWorkspace(ctx, workspace)
    const result = await callTool(ctx, 'kb_write', writeArgs(), { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected kb_write success')
    const value = result.value as { id: string; status: string; path: string; tier: string }
    expect(value.id).toMatch(/^rule-\d{8}-001$/)
    expect(value.status).toBe('draft')
    expect(value.tier).toBe('P2')
    expect(value.path.endsWith(`kb/cards/P2/${value.id}.md`)).toBe(true)

    const file = await import('node:fs/promises').then(fs => fs.readFile(value.path, 'utf8'))
    expect(file).toContain(`id: ${value.id}`)
    expect(file).toContain('状态: draft')
    expect(file).toContain('库: personal')

    const events = agent.session.events.filter(event => event.type === 'kb/write')
    expect(events).toHaveLength(1)
    expect(events[0]!.data).toMatchObject({
      id: value.id,
      library: 'personal',
      tier: 'P2',
      status: 'draft',
      title: '处置标准：XX 类事件怎么办',
    })

    // 有效期 defaults to today + cardTtlDays.
    const expected = new Date()
    expected.setDate(expected.getDate() + 30)
    const key = `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, '0')}-${String(expected.getDate()).padStart(2, '0')}`
    expect(file).toContain(`有效期: ${key}`)
  })

  it('honors an explicit id and every optional field, and dedupes tags', async () => {
    const ctx = await setup()
    const workspace = await makeWorkspace()
    const agent = await agentWithWorkspace(ctx, workspace)
    const result = await callTool(ctx, 'kb_write', writeArgs({
      id: 'rule-20250818-099',
      来源: 'MR#123',
      反例: '直接重启导致二次故障。',
      有效期: '2025-11-16',
      标签: ['告警', '告警', '值班'],
    }), { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected kb_write success')
    const value = result.value as { id: string; path: string }
    expect(value.id).toBe('rule-20250818-099')
    const file = await import('node:fs/promises').then(fs => fs.readFile(value.path, 'utf8'))
    expect(file).toContain('来源: MR#123')
    expect(file).toContain('有效期: 2025-11-16')
    expect(file).toContain('反例 / 踩坑记录')
    const read = await ctx.kb.readCard(workspace, value.id as CardId)
    expect(read.card.标签).toEqual(['告警', '值班'])
  })

  it('generates sequential ids when omitted', async () => {
    const ctx = await setup()
    const workspace = await makeWorkspace()
    const agent = await agentWithWorkspace(ctx, workspace)
    await callTool(ctx, 'kb_write', writeArgs(), { agent })
    const now = new Date()
    const key = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    const second = await callTool(ctx, 'kb_write', writeArgs({ id: `rule-${key}-005` }), { agent })
    const third = await callTool(ctx, 'kb_write', writeArgs(), { agent })
    const ids = [second, third].map(result => (result.value as { id: string }).id)
    expect(ids[0]).toBe(`rule-${key}-005`)
    expect(ids[1]).toBe(`rule-${key}-006`)
  })

  it.each([
    ['blank title', { title: '  ' }, /title must be a non-empty string/],
    ['empty 应做', { 应做: [] }, /应做 must have at least one item/],
    ['blank 应做 item', { 应做: ['ok', ' '] }, /应做 item 1 must be a non-empty string/],
    ['empty 不应做', { 不应做: [] }, /不应做 must have at least one item/],
    ['blank 适用条件', { 适用条件: '' }, /适用条件 must be a non-empty string/],
    ['bad 有效期', { 有效期: '2025-99-99' }, /有效期 must be a YYYY-MM-DD calendar date/],
    ['unsafe id', { id: '../x' }, /id must be a safe file name/],
    ['blank tag', { 标签: ['ok', ' '] }, /标签 item 1 must be a non-empty string/],
    ['blank owner', { 责任人: '' }, /责任人 must be a non-empty string/],
  ])('fails loud on %s', async (_name, over, message) => {
    const ctx = await setup()
    const agent = await agentWithWorkspace(ctx, await makeWorkspace())
    const result = await callTool(ctx, 'kb_write', writeArgs(over), { agent })
    expect(result.isError).toBe(true)
    if (result.isError) expect(text(result)).toMatch(message)
  })

  it('rejects a non-agent caller and a session without a workspace cwd', async () => {
    const ctx = await setup()
    const noAgent = await callTool(ctx, 'kb_write', writeArgs())
    expect(noAgent.isError).toBe(true)
    const session = ctx.sessions.create(SessionId('no-cwd-session'))
    const agent = { id: SessionId('no-cwd'), session } as unknown as Agent
    const noCwd = await callTool(ctx, 'kb_write', writeArgs(), { agent })
    expect(noCwd.isError).toBe(true)
    if (noCwd.isError) expect(text(noCwd)).toMatch(/session has a workspace/)
  })
})

describe('KbService config validation', () => {
  it.each([
    ['cardsPath with ..', { cardsPath: '../up' }, /cardsPath must be a non-empty relative path/],
    ['cardsPath absolute', { cardsPath: '/etc' }, /cardsPath must be a non-empty relative path/],
    ['indexPath with ..', { indexPath: '../up' }, /indexPath must be a non-empty relative path/],
    ['indexPath absolute', { indexPath: '/var/db' }, /indexPath must be a non-empty relative path/],
    ['blank cardsPath', { cardsPath: '' }, /cardsPath must be a non-empty relative path/],
    ['non-integer cardTtlDays', { cardTtlDays: 1.5 }, /cardTtlDays must be a positive integer/],
    ['zero cardTtlDays', { cardTtlDays: 0 }, /cardTtlDays must be a positive integer/],
    ['blank teamRepoPath', { teamRepoPath: '' }, /teamRepoPath must be a non-empty path/],
    ['non-string teamRepoPath', { teamRepoPath: 42 as unknown as string }, /teamRepoPath must be a non-empty path/],
    ['heatPath with ..', { heatPath: '../up' }, /heatPath must be a non-empty relative path/],
    ['blank heatPath', { heatPath: '' }, /heatPath must be a non-empty relative path/],
    ['negative freshnessWarningDays', { freshnessWarningDays: -1 as unknown as number }, /freshnessWarningDays must be a non-negative integer/],
    ['fractional freshnessIntervalDays', { freshnessIntervalDays: 1.5 as unknown as number }, /freshnessIntervalDays must be a non-negative integer/],
    ['non-boolean teamWriteApproval', { teamWriteApproval: 'yes' as unknown as boolean }, /teamWriteApproval must be a boolean/],
  ])('fails loud on %s', async (_name, config, message) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(KbService, config)).rejects.toThrow(message)
  })
})

describe('kb_read', () => {
  it('returns the full card and its tier and path', async () => {
    const ctx = await setup()
    const workspace = await makeWorkspace()
    const agent = await agentWithWorkspace(ctx, workspace)
    await callTool(ctx, 'kb_write', writeArgs({ id: 'rule-20250818-007', 来源: 'MR#1', 反例: '踩坑' }), { agent })
    const result = await callTool(ctx, 'kb_read', { id: 'rule-20250818-007' }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected kb_read success')
    const value = result.value as Record<string, unknown>
    expect(value).toMatchObject({
      id: 'rule-20250818-007',
      title: '处置标准：XX 类事件怎么办',
      库: 'personal',
      状态: 'draft',
      适用条件: '值班时收到 XX 类告警',
      核心结论: '按统一流程处置。',
      应做: ['先确认影响面'],
      不应做: ['不要直接重启'],
      来源: 'MR#1',
      反例: '踩坑',
      责任人: '张三',
      tier: 'P2',
    })
    expect(text(result)).toContain('rule-20250818-007')
  })

  it('errors on a missing card', async () => {
    const ctx = await setup()
    const agent = await agentWithWorkspace(ctx, await makeWorkspace())
    const result = await callTool(ctx, 'kb_read', { id: 'missing-1' }, { agent })
    expect(result.isError).toBe(true)
    if (result.isError) expect(text(result)).toMatch(/card not found: missing-1/)
  })

  it('omits absent optional fields from the canonical value', async () => {
    const ctx = await setup()
    const workspace = await makeWorkspace()
    const agent = await agentWithWorkspace(ctx, workspace)
    await callTool(ctx, 'kb_write', writeArgs({ id: 'rule-20250818-008' }), { agent })
    const result = await callTool(ctx, 'kb_read', { id: 'rule-20250818-008' }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected kb_read success')
    expect((result.value as Record<string, unknown>).来源).toBeUndefined()
    expect((result.value as Record<string, unknown>).反例).toBeUndefined()
  })
})

describe('kb_search', () => {
  it('finds a written card through the FTS index with filters', async () => {
    const ctx = await setup()
    const workspace = await makeWorkspace()
    const agent = await agentWithWorkspace(ctx, workspace)
    await callTool(ctx, 'kb_write', writeArgs({ id: 'rule-20250818-010', 标签: ['告警'] }), { agent })
    const result = await callTool(ctx, 'kb_search', { query: '告警' }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected kb_search success')
    const value = result.value as { mode: string; total: number; hits: { id: string; score: number; 标签: string[] }[] }
    expect(value.mode).toBe('fts')
    expect(value.total).toBe(1)
    expect(value.hits[0]?.id).toBe('rule-20250818-010')
    expect(value.hits[0]?.score).toBeGreaterThan(0)
    expect(value.hits[0]?.标签).toEqual(['告警'])
    expect(text(result)).toContain('rule-20250818-010')
  })

  it('degrades to an explicit scan mode when the index cannot open', async () => {
    const ctx = await setup()
    const workspace = await makeWorkspace()
    // A non-database file at the index path makes the FTS5 open fail.
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(workspace, 'kb'))
    await writeFile(join(workspace, 'kb', '.kb-index.sqlite'), 'not a database', 'utf8')
    const agent = await agentWithWorkspace(ctx, workspace)
    await callTool(ctx, 'kb_write', writeArgs({ id: 'rule-20250818-011' }), { agent })
    const result = await callTool(ctx, 'kb_search', { query: '告警' }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected kb_search success')
    const value = result.value as { mode: string; note?: string; total: number; hits: { id: string }[] }
    expect(value.mode).toBe('scan')
    expect(value.total).toBe(1)
    expect(value.hits[0]?.id).toBe('rule-20250818-011')
    expect(value.note).toMatch(/deterministic full-library scan/)
  })

  it('applies structured filters and validates blank tags', async () => {
    const ctx = await setup()
    const workspace = await makeWorkspace()
    const agent = await agentWithWorkspace(ctx, workspace)
    await callTool(ctx, 'kb_write', writeArgs({ id: 'rule-20250818-012', 标签: ['告警', '值班'] }), { agent })
    await callTool(ctx, 'kb_write', writeArgs({ id: 'case-20250818-013', type: 'case', 标签: ['复盘'] }), { agent })
    const filtered = await callTool(ctx, 'kb_search', {
      query: '告警', type: 'rule', status: 'draft', tier: 'P2', tags: ['值班'],
    }, { agent })
    expect(filtered.isError).toBe(false)
    if (filtered.isError) throw new Error('expected kb_search success')
    const value = filtered.value as { total: number; hits: { id: string }[] }
    expect(value.total).toBe(1)
    expect(value.hits[0]?.id).toBe('rule-20250818-012')

    const blankTag = await callTool(ctx, 'kb_search', { query: '告警', tags: ['ok', ' '] }, { agent })
    expect(blankTag.isError).toBe(true)
    if (blankTag.isError) expect(text(blankTag)).toMatch(/tags item 1 must be a non-empty string/)
  })

  it('reuses the cached index across searches and tolerates unparseable files in the library', async () => {
    const ctx = await setup()
    const workspace = await makeWorkspace()
    const agent = await agentWithWorkspace(ctx, workspace)
    await callTool(ctx, 'kb_write', writeArgs({ id: 'rule-20250818-014' }), { agent })
    const { mkdir, writeFile: write } = await import('node:fs/promises')
    await mkdir(join(workspace, 'kb', 'cards', 'P2'), { recursive: true })
    await write(join(workspace, 'kb', 'cards', 'P2', 'broken.md'), 'not a card', 'utf8')
    const first = await callTool(ctx, 'kb_search', { query: '告警' }, { agent })
    const second = await callTool(ctx, 'kb_search', { query: '告警' }, { agent })
    for (const result of [first, second]) {
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected kb_search success')
      expect((result.value as { mode: string }).mode).toBe('fts')
      expect((result.value as { total: number }).total).toBe(1)
    }
  })

  it('validates limit and query', async () => {
    const ctx = await setup()
    const agent = await agentWithWorkspace(ctx, await makeWorkspace())
    const badLimit = await callTool(ctx, 'kb_search', { query: 'x', limit: 99 }, { agent })
    expect(badLimit.isError).toBe(true)
    if (badLimit.isError) expect(text(badLimit)).toMatch(/limit must be an integer/)
    const blankQuery = await callTool(ctx, 'kb_search', { query: '  ' }, { agent })
    expect(blankQuery.isError).toBe(true)
    if (blankQuery.isError) expect(text(blankQuery)).toMatch(/query must be a non-empty string/)
  })
})

describe('kb_promote', () => {
  it('promotes draft → pending with evidence and pending → ready, appending kb/promote', async () => {
    const ctx = await setup()
    const workspace = await makeWorkspace()
    const agent = await agentWithWorkspace(ctx, workspace)
    await callTool(ctx, 'kb_write', writeArgs({ id: 'rule-20250818-020' }), { agent })

    const first = await callTool(ctx, 'kb_promote', { id: 'rule-20250818-020', target: 'pending', evidence: '已上线 MR#42' }, { agent })
    expect(first.isError).toBe(false)
    if (first.isError) throw new Error('expected kb_promote success')
    expect(first.value).toMatchObject({ id: 'rule-20250818-020', from: 'draft', to: 'pending' })

    const second = await callTool(ctx, 'kb_promote', { id: 'rule-20250818-020', target: 'ready' }, { agent })
    expect(second.isError).toBe(false)
    if (second.isError) throw new Error('expected kb_promote success')
    expect(second.value).toMatchObject({ id: 'rule-20250818-020', from: 'pending', to: 'ready' })

    const events = agent.session.events.filter(event => event.type === 'kb/promote')
    expect(events.map(event => event.data)).toEqual([
      { id: 'rule-20250818-020', from: 'draft', to: 'pending', evidence: '已上线 MR#42' },
      { id: 'rule-20250818-020', from: 'pending', to: 'ready' },
    ])
    const file = await import('node:fs/promises').then(fs => fs.readFile(join(workspace, 'kb/cards/P2/rule-20250818-020.md'), 'utf8'))
    expect(file).toContain('状态: ready')
  })

  it('rejects an illegal transition and a missing card', async () => {
    const ctx = await setup()
    const workspace = await makeWorkspace()
    const agent = await agentWithWorkspace(ctx, workspace)
    const noAgent = await callTool(ctx, 'kb_promote', { id: 'missing-1', target: 'ready' })
    expect(noAgent.isError).toBe(true)
    await callTool(ctx, 'kb_write', writeArgs({ id: 'rule-20250818-021' }), { agent })
    const skip = await callTool(ctx, 'kb_promote', { id: 'rule-20250818-021', target: 'ready' }, { agent })
    expect(skip.isError).toBe(true)
    if (skip.isError) expect(text(skip)).toMatch(/invalid card transition draft → ready/)
    const missing = await callTool(ctx, 'kb_promote', { id: 'gone-1', target: 'pending' }, { agent })
    expect(missing.isError).toBe(true)
    if (missing.isError) expect(text(missing)).toMatch(/card not found: gone-1/)
  })
})

describe('presentation projections', () => {
  it('declares the render intents for all four tools', async () => {
    const ctx = await setup()
    const def = ctx.tools.get('kb_write')!
    expect(def.presentCall?.(writeArgs({ id: 'rule-1' }))).toEqual({
      card: 'generic',
      title: '写卡片 rule-1',
      kind: 'other',
      locations: [{ path: 'kb/cards/P2/rule-1.md' }],
    })
    expect(def.presentCall?.(writeArgs())).toEqual({
      card: 'generic',
      title: '写卡片 （自动生成 id）',
      kind: 'other',
    })
    const read = ctx.tools.get('kb_read')!
    expect(read.presentCall?.({ id: 'rule-1' })).toEqual({ card: 'generic', title: '读卡片 rule-1', kind: 'other', rawInput: { id: 'rule-1' } })
    const promote = ctx.tools.get('kb_promote')!
    expect(promote.presentCall?.({ id: 'rule-1', target: 'pending' })).toEqual({
      card: 'generic', title: '晋升卡片 rule-1 → pending', kind: 'other', rawInput: { id: 'rule-1', target: 'pending' },
    })
  })

  it('presents the kb_write, kb_read, and kb_promote completed results', async () => {
    const ctx = await setup()
    const content = [{ type: 'text', text: 'x' } as { type: 'text'; text: string }]
    const write = ctx.tools.get('kb_write')!
    expect(write.presentResult?.(writeArgs({ id: 'rule-1' }), { content, isError: false }))
      .toEqual({ card: 'generic', title: '卡片已写入', content })
    const read = ctx.tools.get('kb_read')!
    expect(read.presentResult?.({ id: 'rule-1' }, { content, isError: false }))
      .toEqual({ card: 'generic', title: '卡片内容', content })
    const promote = ctx.tools.get('kb_promote')!
    expect(promote.presentResult?.({ id: 'rule-1', target: 'pending' }, { content, isError: false }))
      .toEqual({ card: 'generic', title: '卡片已晋升', content })
  })

  it('drives the service importDir seam', async () => {
    const ctx = await setup()
    const workspace = await makeWorkspace()
    const { mkdir, writeFile: write } = await import('node:fs/promises')
    const sourceDir = join(workspace, 'sources')
    await mkdir(sourceDir)
    await write(join(sourceDir, 'card.md'), `---
id: rule-20250818-030
type: rule
title: 导入的规则
库: team
状态: ready
适用条件: 导入场景
责任人: 数据员
有效期: 2025-11-16
标签: [导入]
---

## 核心结论
导入结论

## 应做
- 动作

## 不应做
- 反动作
`, 'utf8')
    const result = await ctx.kb.importDir({ root: workspace, sourceDir, tier: 'P2' })
    expect(result.imported).toEqual(['rule-20250818-030'])
    const info = await ctx.kb.readCard(workspace, 'rule-20250818-030' as CardId)
    expect(info.card.状态).toBe('draft')
    expect(info.card.库).toBe('personal')
  })

  it('projects kb_search meta and presents the search card with fallbacks', async () => {
    const ctx = await setup()
    const def = ctx.tools.get('kb_search')!
    const canonical = {
      mode: 'fts',
      total: 2,
      hits: [
        { id: 'rule-1', title: 't', type: 'rule', status: 'draft', tier: 'P2', path: '/w/kb/cards/P2/rule-1.md', 适用条件: 'c', 标签: [], score: 1.5 },
        { id: 'rule-2', title: 't2', type: 'rule', status: 'draft', tier: 'P2', path: '/w/kb/cards/P2/rule-2.md', 适用条件: 'c', 标签: [], score: 1.2 },
      ],
    }
    const meta = def.output.presentationMeta?.({ query: '告警' }, canonical)
    expect(meta).toEqual(canonical)
    const view = def.presentResult?.({ query: '告警' }, { content: [{ type: 'text', text: 'x' }], isError: false, ...meta === undefined ? {} : { meta } })
    expect(view).toEqual({
      card: 'search',
      shape: 'paths',
      paths: ['/w/kb/cards/P2/rule-1.md', '/w/kb/cards/P2/rule-2.md'],
      truncated: false,
      total: 2,
    })
    const fallback = def.presentResult?.({ query: '告警' }, { content: [{ type: 'text', text: 'x' }], isError: false })
    expect(fallback).toEqual({ card: 'generic', title: '检索完成', content: [{ type: 'text', text: 'x' }] })
    expect(def.presentCall?.({ query: '告警' })).toEqual({ card: 'generic', title: '检索知识库：告警', kind: 'search', rawInput: '告警' })
  })
})
