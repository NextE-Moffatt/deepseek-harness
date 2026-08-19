/**
 * Built-bin stdio smoke for `@deepseek-ai/dsh-kb-mcp-server`: spawn the built
 * `lib/bin.js` under plain Node and drive it through the SDK client over real
 * stdio — the honest "real entry path" proof that the composed server speaks
 * MCP on the wire. Skips before build (`lib/bin.js` absent); the workspace and
 * cards are real, so the transcript is deterministic.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const binPath = join(repoRoot, 'packages/kb/kb-mcp-server/lib/bin.js')

const CARD_MD = [
  '---',
  'id: rule-20260818-001',
  'type: rule',
  'title: 告警处置标准',
  '库: personal',
  '状态: ready',
  '适用条件: 值班收到告警',
  '来源: https://example.com/MR-1',
  '责任人: 本人',
  '有效期: 2099-01-01',
  '标签:',
  '  - 告警',
  '---',
  '',
  '## 核心结论',
  '',
  '先确认影响面，再处置。',
  '',
  '## 应做',
  '',
  '- 确认影响面',
  '',
  '## 不应做',
  '',
  '- 直接重启',
  '',
].join('\n')

let workspace: string | undefined

afterEach(async () => {
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true })
  workspace = undefined
})

describe('dsh-kb-mcp built bin over stdio', () => {
  it.skipIf(!existsSync(binPath))('lists the read-only tools and serves the real reference pool', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'dsh-kb-mcp-bin-'))
    await mkdir(join(workspace, 'kb/cards/P2'), { recursive: true })
    await writeFile(join(workspace, 'kb/cards/P2/rule-20260818-001.md'), CARD_MD)

    const client = new Client({ name: 'kb-mcp-built-bin', version: '0.0.1' })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [binPath],
      env: {
        ...process.env as Record<string, string>,
        KB_MCP_ROOT: workspace,
      },
      stderr: 'inherit',
    })
    try {
      await client.connect(transport)
      const tools = await client.listTools()
      expect(tools.tools.map(tool => tool.name).sort()).toEqual(['freshness_review', 'heat', 'read_card', 'search_cards'])

      const search = await client.callTool({ name: 'search_cards', arguments: { query: '告警' } })
      const hits = search.structuredContent as { hits: { id: string }[] }
      expect(hits.hits.map(hit => hit.id)).toContain('rule-20260818-001')

      const read = await client.callTool({ name: 'read_card', arguments: { id: 'rule-20260818-001' } })
      expect(read.structuredContent).toMatchObject({ id: 'rule-20260818-001', title: '告警处置标准' })

      const freshness = await client.callTool({ name: 'freshness_review', arguments: {} })
      expect(freshness.structuredContent).toMatchObject({ total: 0 })
    } finally {
      await client.close()
    }
  })
})
