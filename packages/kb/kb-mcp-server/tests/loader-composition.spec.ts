/**
 * Real-composition acceptance chain for `@deepseek-ai/dsh-kb-mcp-server`:
 * boots a test-only cordis.yml through the real Loader with the service stack
 * and kb-core mounted, mounts the server plugin over the SDK's in-memory
 * transport, and drives the four read-only tools through the SDK client
 * against real cards in a real workspace — the only mock is the transport
 * boundary (the built-bin e2e covers the real stdio bin).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import KbCore from '@deepseek-ai/dsh-kb-core'
import type { CardId, KbService } from '@deepseek-ai/dsh-kb-core'
import { apply, inject, name } from '@deepseek-ai/dsh-kb-mcp-server'
import type { KbMcpServerConfig } from '@deepseek-ai/dsh-kb-mcp-server'

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

async function boot(): Promise<{ ctx: Context; kb: KbService }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-kb-mcp-loader-'))
  workspace = await mkdtemp(join(tmpdir(), 'dsh-kb-mcp-workspace-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-kb-core'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-kb-core', KbCore],
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
  return { ctx, kb: ctx.get('kb') as KbService }
}

/** A real personal card in the workspace library. */
async function writeCard(kb: KbService, id: string, title: string, extra: Record<string, string | string[]> = {}): Promise<void> {
  await kb.writeCard(workspace!, {
    tier: 'P2', id: id as CardId, type: 'rule', title,
    适用条件: '任何会话', 核心结论: '结论', 应做: ['做'], 不应做: ['不做'],
    来源: 'https://example.com/x', 责任人: '本人', 有效期: '2099-01-01', 标签: ['kb'],
    ...extra,
  })
}

describe('kb MCP server through the Loader composition', () => {
  it('serves the real reference pool through the SDK client over the in-memory transport', async () => {
    const { ctx, kb } = await boot()
    await writeCard(kb, 'rule-20260818-001', '告警处置标准')
    await writeCard(kb, 'rule-20260818-002', '发布流程')

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await ctx.plugin({ name, inject, apply: (c: Context, cfg: KbMcpServerConfig) => apply(c, cfg, serverTransport) }, { root: workspace! })

    const client = new Client({ name: 'kb-mcp-composition', version: '0.0.1' })
    await client.connect(clientTransport)

    // tools/list exposes exactly the four read-only tools.
    const tools = await client.listTools()
    expect(tools.tools.map(tool => tool.name).sort()).toEqual(['freshness_review', 'heat', 'read_card', 'search_cards'])

    // search_cards finds the real card by its Chinese vocabulary.
    const search = await client.callTool({ name: 'search_cards', arguments: { query: '告警' } })
    expect(search.structuredContent).toMatchObject({ mode: 'fts' })
    const hits = search.structuredContent as { hits: { id: string }[] }
    expect(hits.hits.map(hit => hit.id)).toContain('rule-20260818-001')

    // read_card returns the full real card.
    const read = await client.callTool({ name: 'read_card', arguments: { id: 'rule-20260818-001' } })
    expect(read.structuredContent).toMatchObject({ id: 'rule-20260818-001', title: '告警处置标准' })

    // freshness_review scans the real library (neither card is flagged; the
    // list is empty but the scan itself runs against the real files).
    const freshness = await client.callTool({ name: 'freshness_review', arguments: { today: '2026-08-19' } })
    expect(freshness.structuredContent).toMatchObject({ total: 0 })

    // heat reads the real (empty) ledger.
    const heat = await client.callTool({ name: 'heat', arguments: {} })
    expect(heat.structuredContent).toEqual({ rows: [] })

    await client.close()
  })

  it('fails loud at load on a relative root', async () => {
    const ctx = new Context()
    context = ctx
    const configPath = join(await mkdtemp(join(tmpdir(), 'dsh-kb-mcp-loader-')), 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-kb-core'",
      "- name: '@deepseek-ai/dsh-kb-mcp-server'",
      '  config:',
      '    root: kb/workspace',
      '',
    ].join('\n'))
    ctx.baseUrl = pathToFileURL(configPath).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-kb-core', KbCore],
      ['@deepseek-ai/dsh-kb-mcp-server', { name, inject, apply }],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        const module = modules.get(specifier)
        if (module === undefined) throw new Error(`unexpected import ${specifier}`)
        return module as never
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await expect(ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } }))
      .rejects.toThrow(/root must be an absolute path/)
  })
})
