/**
 * Unit coverage of `@deepseek-ai/dsh-kb-mcp-server`: config validation, the
 * render functions, and the four read-only tools over the SDK's in-memory
 * transport against a stubbed kb boundary (the loader-composition spec drives
 * the real chain; the built-bin e2e drives the real stdio bin).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { KbService } from '@deepseek-ai/dsh-kb-core'
import type { CardId } from '@deepseek-ai/dsh-kb-core'
import {
  Config, DEFAULT_SEARCH_LIMIT, apply, createKbMcpServer, renderCard, renderHeat,
  renderSearchOutcome, resolveRoot,
} from '@deepseek-ai/dsh-kb-mcp-server'

const ROOT = '/tmp/kb-workspace'
const CARD = 'rule-20260818-001' as CardId

/** One kb stub with its callable mock handles exposed for assertion. */
interface KbStub {
  kb: KbService
  mocks: {
    search: ReturnType<typeof vi.fn>
    personalCard: ReturnType<typeof vi.fn>
    teamCard: ReturnType<typeof vi.fn>
    teamRead: ReturnType<typeof vi.fn>
    freshnessReview: ReturnType<typeof vi.fn>
    heat: ReturnType<typeof vi.fn>
  }
}

/** Build a stubbed kb service exposing the MCP tools' read surface. */
function kbLike(overrides: Partial<KbService> = {}): KbStub {
  const mocks = {
    search: vi.fn(async () => ({
      mode: 'fts' as const,
      total: 1,
      hits: [{ id: CARD, title: '规则', type: 'rule', status: 'ready', tier: 'P2', path: '/cards/rule.md', 适用条件: '任何会话', 标签: ['kb'], score: -1 }],
    })),
    personalCard: vi.fn(async () => ({
      card: { id: CARD, type: 'rule', title: '规则', 库: 'personal', 状态: 'ready', 适用条件: '任何会话', 核心结论: '结论', 应做: ['做'], 不应做: ['不做'], 责任人: '本人', 有效期: '2099-01-01', 标签: ['kb'] } as never,
      tier: 'P2',
      path: '/cards/rule.md',
    })),
    teamCard: vi.fn(async () => undefined),
    teamRead: vi.fn(async () => ({
      card: { id: CARD, type: 'rule', title: '团队规则', 库: 'team', 状态: 'pending', 适用条件: '团队场景', 核心结论: '结论', 应做: ['做'], 不应做: ['不做'], 责任人: '本人', 有效期: '2099-01-01', 标签: ['kb'] } as never,
      path: '/team/cards/rule.md',
      mtime: 1,
      size: 1,
    })),
    freshnessReview: vi.fn(async () => ({
      overdue: [{ id: CARD, title: '规则', library: 'personal', status: 'ready', grade: 'verify', 有效期: '2026-08-01', daysLeft: -18, heat: 1, recommend: 'renew' }],
      expiringSoon: [],
      total: 1,
    })),
    heat: vi.fn(async () => [
      { cardId: CARD, count: 2, lastAt: '2026-08-18T10:00:00.000Z', sessions: ['s1', 's2'], packs: ['包'] },
    ]),
  }
  const kb = { ...mocks, ...overrides } as unknown as KbService
  return { kb, mocks }
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.length = 0
  vi.restoreAllMocks()
})

/** Mount the server plugin over the in-memory transport and return the client. */
async function mountServer(kb: KbService, config: Record<string, unknown> = { root: ROOT }): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('kb', kb)
  await apply(ctx, config as never, serverTransport)
  const client = new Client({ name: 'kb-mcp-test', version: '0.0.1' })
  await client.connect(clientTransport)
  return client
}

describe('resolveRoot and Config', () => {
  it('accepts an absolute root', () => {
    expect(resolveRoot({ root: ROOT })).toBe(ROOT)
  })

  it.each([
    ['relative path', { root: 'kb/workspace' }, /root must be an absolute path/],
    ['empty string', { root: '' }, /root must be an absolute path/],
  ] as const)('fails loud on %s', (_label, config, pattern) => {
    expect(() => resolveRoot(config as never)).toThrow(pattern)
  })

  it('declares a required root schema', () => {
    expect(() => Config({} as never)).toThrow(/root/)
  })
})

describe('render functions', () => {
  it('renders a scan-mode search outcome with its note', () => {
    const text = renderSearchOutcome({
      mode: 'scan', total: 2,
      hits: [
        { id: CARD, title: '规则', type: 'rule', status: 'ready', tier: 'P2', library: 'personal', path: '/x', 适用条件: '任何会话', 标签: ['kb'], score: 0 },
        { id: 'case-1' as CardId, title: '案例', type: 'case', status: 'pending', tier: 'P1', library: 'personal', path: '/y', 适用条件: '值班', 标签: [], score: 0 },
      ],
      note: 'FTS5 index unavailable; results are a deterministic full-library scan',
    })
    expect(text).toContain('知识库检索（scan）：命中 2 张卡片')
    expect(text).toContain('- rule-20260818-001（个人/ready/P2）规则：任何会话')
    expect(text).toContain('FTS5 index unavailable')
  })

  it('renders a card with optional fields omitted', () => {
    const text = renderCard(
      { id: CARD, type: 'rule', title: '规则', 库: 'personal', 状态: 'draft', 适用条件: 'a', 核心结论: 'b', 应做: ['x'], 不应做: ['y'], 责任人: '本人', 有效期: '2026-08-19', 标签: ['kb'] },
      '/cards/rule.md',
    )
    expect(text).toContain('id: rule-20260818-001')
    expect(text).not.toContain('来源:')
    expect(text).not.toContain('反例:')
    expect(text).toContain('path: /cards/rule.md')
  })

  it('renders a card with the optional source and counter-example fields', () => {
    const text = renderCard(
      { id: CARD, type: 'case', title: '案例', 库: 'team', 状态: 'ready', 适用条件: 'a', 核心结论: 'b', 应做: ['x'], 不应做: ['y'], 来源: 'https://example.com', 反例: '当时没这么做', 责任人: '本人', 有效期: '2026-08-19', 标签: ['kb'] },
      '/team/cards/rule.md',
    )
    expect(text).toContain('来源: https://example.com')
    expect(text).toContain('反例: 当时没这么做')
  })

  it('renders the heat ledger with a session-less row', () => {
    const text = renderHeat([
      { cardId: CARD, count: 2, lastAt: '', sessions: [], packs: [] },
      { cardId: 'case-1' as CardId, count: 1, lastAt: '', sessions: ['s1'], packs: [] },
    ])
    expect(text).toContain('知识热度账本：2 张卡片被消费')
    expect(text).toContain('- rule-20260818-001：2 次注入，最近会话 无')
  })
})

describe('read-only MCP tools over the in-memory transport', () => {
  it('exposes exactly the four read-only tools', async () => {
    const client = await mountServer(kbLike().kb)
    const tools = await client.listTools()
    expect(tools.tools.map(tool => tool.name).sort()).toEqual(['freshness_review', 'heat', 'read_card', 'search_cards'])
  })

  it('search_cards forwards the query and filters, defaults the limit, and returns text plus structured content', async () => {
    const { kb, mocks } = kbLike()
    const client = await mountServer(kb)
    const result = await client.callTool({ name: 'search_cards', arguments: { query: '告警', type: 'rule', limit: 3 } })
    expect(mocks.search).toHaveBeenCalledWith(ROOT, { query: '告警', type: 'rule', limit: 3 })
    const structured = result.structuredContent as { mode: string; total: number }
    expect(structured.mode).toBe('fts')
    expect((result.content as { type: string }[])[0]!.type).toBe('text')

    await client.callTool({ name: 'search_cards', arguments: { query: 'x' } })
    expect(mocks.search).toHaveBeenLastCalledWith(ROOT, { query: 'x', limit: DEFAULT_SEARCH_LIMIT })

    await client.callTool({
      name: 'search_cards',
      arguments: { query: 'y', status: 'ready', tier: 'P2', tags: ['kb'], limit: 2 },
    })
    expect(mocks.search).toHaveBeenLastCalledWith(ROOT, { query: 'y', status: 'ready', tier: 'P2', tags: ['kb'], limit: 2 })
  })

  it('read_card reads the personal library by default and falls back to the team library', async () => {
    const { kb, mocks } = kbLike()
    const client = await mountServer(kb)
    const personal = await client.callTool({ name: 'read_card', arguments: { id: CARD } })
    expect(personal.structuredContent).toMatchObject({ 库: 'personal' })
    // A personal miss falls back to the team library when no library is given.
    mocks.personalCard.mockResolvedValueOnce(undefined)
    mocks.teamCard.mockResolvedValueOnce({
      card: { id: CARD, type: 'rule', title: '团队规则', 库: 'team', 状态: 'pending', 适用条件: 't', 核心结论: 'c', 应做: ['x'], 不应做: ['y'], 责任人: '本人', 有效期: '2099-01-01', 标签: [] },
      path: '/team/cards/rule.md', mtime: 1, size: 1,
    })
    const team = await client.callTool({ name: 'read_card', arguments: { id: CARD } })
    expect(team.structuredContent).toMatchObject({ 库: 'team' })
    // An explicit team read goes straight to the team library.
    const explicit = await client.callTool({ name: 'read_card', arguments: { id: CARD, library: 'team' } })
    expect(explicit.structuredContent).toMatchObject({ 库: 'team' })
    expect(mocks.teamRead).toHaveBeenCalledTimes(1)
  })

  it('read_card fails loud when no library holds the id', async () => {
    const { kb, mocks } = kbLike()
    mocks.personalCard.mockResolvedValueOnce(undefined)
    const client = await mountServer(kb)
    const result = await client.callTool({ name: 'read_card', arguments: { id: 'missing-1' } })
    expect(result.isError).toBe(true)
    expect((result.content as { text: string }[])[0]!.text).toContain('card not found: missing-1')

    // An explicit personal read never consults the team library on a miss.
    mocks.personalCard.mockResolvedValueOnce(undefined)
    const personalOnly = await client.callTool({ name: 'read_card', arguments: { id: 'missing-2', library: 'personal' } })
    expect(personalOnly.isError).toBe(true)
    // Only the first (library-absent) miss consulted the team library.
    expect(mocks.teamCard).toHaveBeenCalledTimes(1)
  })

  it('freshness_review renders the review list and returns the structured review', async () => {
    const { kb, mocks } = kbLike()
    const client = await mountServer(kb)
    const result = await client.callTool({ name: 'freshness_review', arguments: { today: '2026-08-19' } })
    expect(mocks.freshnessReview).toHaveBeenCalledWith(ROOT, '2026-08-19')
    expect((result.content as { type: string; text: string }[])[0]!.text).toContain('知识保鲜扫描（2026-08-19）：1 张卡片待复核')
    expect(result.structuredContent).toMatchObject({ total: 1 })

    await client.callTool({ name: 'freshness_review', arguments: {} })
    expect(mocks.freshnessReview).toHaveBeenLastCalledWith(ROOT, undefined)
  })

  it('heat returns the ledger rows and the rendered text', async () => {
    const { kb, mocks } = kbLike()
    const client = await mountServer(kb)
    const result = await client.callTool({ name: 'heat', arguments: {} })
    expect(mocks.heat).toHaveBeenCalledWith(ROOT)
    expect((result.structuredContent as { rows: unknown[] }).rows).toHaveLength(1)
    expect((result.content as { type: string; text: string }[])[0]!.text).toContain('知识热度账本：1 张卡片被消费')
  })

  it('createKbMcpServer disposes cleanly when the client closes', async () => {
    const kb = kbLike().kb
    const server = createKbMcpServer(kb, ROOT)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'kb-mcp-test', version: '0.0.1' })
    await client.connect(clientTransport)
    await client.close()
    await server.close()
  })
})
