// Real-composition acceptance chain: boots a test-only cordis.yml through the
// real Loader with kb-core mounted, then drives the acceptance path in a real
// workspace directory — kb_write a draft card → kb_search finds it → kb_promote
// flips the state → the kb/* events replay from the session log.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as KbCore from '@deepseek-ai/dsh-kb-core'

let root: string | undefined
let workspace: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const dir of [root, workspace]) {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
  root = undefined
  workspace = undefined
})

/** A fake parent Agent backed by a real session whose cwd is the workspace. */
function agent(ctx: Context, cwd: string): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('kb-loader-agent')
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    cwd,
  })
  const value: Agent = {
    id, options: {}, session, inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function boot(configLines: readonly string[] = []): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-kb-loader-'))
  workspace = await mkdtemp(join(tmpdir(), 'dsh-kb-workspace-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-kb-core'",
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
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('kb-core real composition', () => {
  it('acceptance chain: kb_write → kb_search → kb_promote, replayable from the log', async () => {
    const ctx = await boot()
    const caller = agent(ctx, workspace!)

    const write = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('loader-write'),
      name: 'kb_write',
      arguments: {
        tier: 'P2',
        type: 'rule',
        title: '告警处置标准',
        适用条件: '值班收到告警',
        核心结论: '先确认影响面。',
        应做: ['确认影响面'],
        不应做: ['直接重启'],
        责任人: '张三',
        标签: ['告警'],
      },
      agent: caller,
    })
    expect(write.isError).toBe(false)
    if (write.isError) throw new Error('kb_write failed in composition')
    const cardId = (write.value as { id: string }).id
    expect(cardId).toMatch(/^rule-\d{8}-001$/)
    expect(await readFile(join(workspace!, 'kb/cards/P2', `${cardId}.md`), 'utf8')).toContain('状态: draft')

    const search = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('loader-search'),
      name: 'kb_search',
      arguments: { query: '告警' },
      agent: caller,
    })
    expect(search.isError).toBe(false)
    if (search.isError) throw new Error('kb_search failed in composition')
    const found = search.value as { mode: string; total: number; hits: { id: string }[] }
    expect(found.mode).toBe('fts')
    expect(found.total).toBe(1)
    expect(found.hits[0]?.id).toBe(cardId)

    const promote = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('loader-promote'),
      name: 'kb_promote',
      arguments: { id: cardId, target: 'pending', evidence: 'MR#42' },
      agent: caller,
    })
    expect(promote.isError).toBe(false)
    if (promote.isError) throw new Error('kb_promote failed in composition')
    expect(promote.value).toMatchObject({ id: cardId, from: 'draft', to: 'pending' })
    expect(await readFile(join(workspace!, 'kb/cards/P2', `${cardId}.md`), 'utf8')).toContain('状态: pending')

    // Log replay: a fresh session seeded with the caller's log reconstructs the
    // full acceptance chain — the write, the search call, and the promotion.
    const log = caller.session.events.map(event => ({ type: event.type, data: event.data }))
    expect(log.filter(event => event.type === 'kb/write')).toHaveLength(1)
    expect(log.filter(event => event.type === 'kb/promote')).toHaveLength(1)
    const replayed = Session.create(SessionId('replay'), caller.session.events)
    const replayKbEvents = replayed.events
      .filter(event => event.type === 'kb/write' || event.type === 'kb/promote')
      .map(event => ({ type: event.type, data: event.data }))
    expect(replayKbEvents).toEqual(log.filter(event => event.type === 'kb/write' || event.type === 'kb/promote'))
    expect(replayed.events.some(event =>
      event.type === 'kb/promote' && event.data.id === cardId && event.data.from === 'draft' && event.data.to === 'pending',
    )).toBe(true)
    expect(resultText(write)).toContain(cardId)
  })

  it('mounts with an explicit config block from cordis.yml', async () => {
    const ctx = await boot([
      '    cardsPath: kb/my-cards',
      '    indexPath: kb/my-index.sqlite',
      '    cardTtlDays: 7',
    ])
    expect(ctx.kb.config).toEqual({
      cardsPath: 'kb/my-cards',
      indexPath: 'kb/my-index.sqlite',
      cardTtlDays: 7,
    })
    const description = ctx.tools.schemas().find(schema => schema.name === 'kb_write')!.description
    expect(description).toContain('7')
  })
})
