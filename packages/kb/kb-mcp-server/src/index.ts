/**
 * `kb-mcp-server`: a read-only MCP server exposing the knowledge-base
 * reference pool over stdio — `search_cards` / `read_card` /
 * `freshness_review` / `heat`, every handler a pure read through `ctx.kb`.
 * The write side stays inside the harness (tools and workbench), where
 * `kb/*` events are logged. The package's `dsh-kb-mcp` bin boots the minimal
 * composition (system-prompt / tools / kb-core / this server) and serves
 * until the client disconnects.
 * @module @deepseek-ai/dsh-kb-mcp-server
 */

import { Context } from '@deepseek-ai/cordis'
import { isAbsolute } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { renderReviewList, todayString } from '@deepseek-ai/dsh-kb-core'
import type {
  Card, CardId, CardLibrary, CardStatus, CardTier, CardType, HeatRow, KbService,
  SearchHit, SearchOutcome, SearchRequest,
} from '@deepseek-ai/dsh-kb-core'
import { CARD_STATUSES, CARD_TIERS, CARD_TYPES } from '@deepseek-ai/dsh-kb-core'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'kb-mcp-server'

/** Services required by this plugin. */
export const inject = ['kb']

/** Default hit cap of `search_cards` (the kb_search tool's default). */
export const DEFAULT_SEARCH_LIMIT = 10

/** Configuration for the kb MCP server. */
export interface KbMcpServerConfig {
  /** The workspace root whose reference pool this server exposes (absolute). */
  root: string
}

/** Schema-validated configuration. */
export const Config = z.object({
  root: z.string().required(),
}) as unknown as z<KbMcpServerConfig>

/**
 * Resolve and validate the server configuration; invalid values fail loud at
 * load.
 * @param config - raw configuration.
 * @returns the absolute workspace root.
 */
export function resolveRoot(config: KbMcpServerConfig): string {
  if (!isAbsolute(config.root)) {
    throw new Error(`KbMcpServerConfig.root must be an absolute path, got ${JSON.stringify(config.root)}`)
  }
  return config.root
}

/** One search hit rendered as a list line. */
function renderHit(hit: SearchHit): string {
  return `- ${hit.id}（${hit.status}/${hit.tier}）${hit.title}：${hit.适用条件}`
}

/** Render one search outcome as the model-facing text block.
 * @param outcome - the retrieval outcome.
 * @returns the rendered list text.
 */
export function renderSearchOutcome(outcome: SearchOutcome): string {
  const lines = [`知识库检索（${outcome.mode === 'fts' ? 'FTS5' : 'scan'}）：命中 ${outcome.total} 张卡片`]
  for (const hit of outcome.hits) lines.push(renderHit(hit))
  if (outcome.note !== undefined) lines.push(outcome.note)
  return lines.join('\n')
}

/** Render one card's knowledge fields as the model-facing text block.
 * @param card - the card.
 * @param path - the card's absolute file path.
 * @returns the rendered card text.
 */
export function renderCard(card: Card, path: string): string {
  return [
    `id: ${card.id}`,
    `type: ${card.type}`,
    `title: ${card.title}`,
    `库: ${card.库}`,
    `状态: ${card.状态}`,
    `适用条件: ${card.适用条件}`,
    `核心结论: ${card.核心结论}`,
    `应做: ${card.应做.join('；')}`,
    `不应做: ${card.不应做.join('；')}`,
    ...card.来源 === undefined ? [] : [`来源: ${card.来源}`],
    `责任人: ${card.责任人}`,
    `有效期: ${card.有效期}`,
    `标签: ${card.标签.join('、')}`,
    ...card.反例 === undefined ? [] : [`反例: ${card.反例}`],
    `path: ${path}`,
  ].join('\n')
}

/** Render the heat ledger as the model-facing text block.
 * @param rows - the aggregated heat rows.
 * @returns the rendered ledger text.
 */
export function renderHeat(rows: readonly HeatRow[]): string {
  const lines = [`知识热度账本：${rows.length} 张卡片被消费`]
  for (const row of rows) {
    const lastSession = row.sessions[row.sessions.length - 1] ?? '无'
    lines.push(`- ${row.cardId}：${row.count} 次注入，最近会话 ${lastSession}`)
  }
  return lines.join('\n')
}

/** The input schema of `search_cards` (a zod raw shape the SDK lowers to JSON Schema). */
export const SEARCH_CARDS_SCHEMA = {
  query: zod.string().describe('全文检索词'),
  type: zod.enum(CARD_TYPES).optional().describe('卡片类型过滤'),
  status: zod.enum(CARD_STATUSES).optional().describe('生命周期状态过滤'),
  tier: zod.enum(CARD_TIERS).optional().describe('个人库层级过滤'),
  tags: zod.array(zod.string()).optional().describe('标签过滤（全部命中）'),
  limit: zod.number().int().min(1).max(50).optional().describe('最大命中数，缺省 10'),
} satisfies zod.ZodRawShape

/** Arguments of one `search_cards` call. */
export interface SearchCardsArgs {
  query: string
  type?: CardType
  status?: CardStatus
  tier?: CardTier
  tags?: string[]
  limit?: number
}

/** The input schema of `read_card`. */
export const READ_CARD_SCHEMA = {
  id: zod.string().describe('卡片 id，如 rule-20250818-001'),
  library: zod.enum(['personal', 'team']).optional().describe('库；缺省先查个人库，未命中再查团队库'),
} satisfies zod.ZodRawShape

/** Arguments of one `read_card` call. */
export interface ReadCardArgs {
  id: string
  library?: CardLibrary
}

/** The input schema of `freshness_review`. */
export const FRESHNESS_REVIEW_SCHEMA = {
  today: zod.string().optional().describe('基准日期 YYYY-MM-DD，缺省今天'),
} satisfies zod.ZodRawShape

/** Arguments of one `freshness_review` call. */
export interface FreshnessReviewArgs {
  today?: string
}

/** The input schema of `heat`. */
export const HEAT_SCHEMA = {} satisfies zod.ZodRawShape

/**
 * Build the read-only MCP server bound to one workspace's kb service.
 * @param kb - the kb service (its configuration owns the library paths).
 * @param root - the workspace root the server exposes.
 * @returns the MCP server with the four read-only tools registered.
 */
export function createKbMcpServer(kb: KbService, root: string): McpServer {
  const server = new McpServer({ name: 'dsh-kb-mcp', version: '0.1.0' })

  server.registerTool('search_cards', {
    title: 'Search knowledge cards',
    description: '检索知识库卡片：FTS5 BM25 全文检索，可叠加类型/状态/层级/标签过滤；索引不可用时退化为确定性全库扫描并注明。',
    inputSchema: SEARCH_CARDS_SCHEMA,
  }, async (args) => {
    const request: SearchRequest = {
      query: args.query,
      ...args.type === undefined ? {} : { type: args.type },
      ...args.status === undefined ? {} : { status: args.status },
      ...args.tier === undefined ? {} : { tier: args.tier },
      ...args.tags === undefined ? {} : { tags: args.tags },
      limit: args.limit ?? DEFAULT_SEARCH_LIMIT,
    }
    const outcome = await kb.search(root, request)
    return {
      content: [{ type: 'text', text: renderSearchOutcome(outcome) }],
      structuredContent: outcome as unknown as Record<string, unknown>,
    }
  })

  server.registerTool('read_card', {
    title: 'Read one knowledge card',
    description: '读取一张完整卡片（标题、适用条件、核心结论、应做、不应做、反例等知识字段）；缺省先查个人库，未命中再查团队库。',
    inputSchema: READ_CARD_SCHEMA,
  }, async (args) => {
    const id = args.id as CardId
    if (args.library === 'team') {
      const team = await kb.teamRead(root, id)
      return {
        content: [{ type: 'text', text: renderCard(team.card, team.path) }],
        structuredContent: team.card as unknown as Record<string, unknown>,
      }
    }
    const personal = await kb.personalCard(root, id)
    if (personal !== undefined) {
      return {
        content: [{ type: 'text', text: renderCard(personal.card, personal.path) }],
        structuredContent: personal.card as unknown as Record<string, unknown>,
      }
    }
    if (args.library === undefined) {
      const team = await kb.teamCard(root, id)
      if (team !== undefined) {
        return {
          content: [{ type: 'text', text: renderCard(team.card, team.path) }],
          structuredContent: team.card as unknown as Record<string, unknown>,
        }
      }
    }
    throw new Error(`card not found: ${id}`)
  })

  server.registerTool('freshness_review', {
    title: 'Freshness pending-review list',
    description: '知识保鲜待复核清单：已过期与即将过期的卡片及其治理建议（复核续期/待复核/归档/复活）。',
    inputSchema: FRESHNESS_REVIEW_SCHEMA,
  }, async (args) => {
    const review = await kb.freshnessReview(root, args.today)
    return {
      content: [{ type: 'text', text: renderReviewList(review, args.today ?? todayString()) }],
      structuredContent: review as unknown as Record<string, unknown>,
    }
  })

  server.registerTool('heat', {
    title: 'Knowledge heat ledger',
    description: '知识热度账本：每张被注入卡片的消费次数、最近消费会话与注入知识包。',
    inputSchema: HEAT_SCHEMA,
  }, async () => {
    const rows = await kb.heat(root)
    return {
      content: [{ type: 'text', text: renderHeat(rows) }],
      structuredContent: { rows } as unknown as Record<string, unknown>,
    }
  })

  return server
}

/**
 * Connect the read-only server to one transport and register the disposal
 * effect. The stdio transport keeps the process alive while the client holds
 * stdin open; composition tests pass the SDK's in-memory transport instead.
 * @param ctx - registrant context carrying the kb service.
 * @param config - resolved server configuration.
 * @param transport - the transport to serve over (defaults to stdio).
 * @returns after the transport connection settles.
 */
export async function apply(ctx: Context, config: KbMcpServerConfig, transport: Transport = new StdioServerTransport()): Promise<void> {
  const root = resolveRoot(config)
  const server = createKbMcpServer(ctx.kb, root)
  ctx.effect(() => {
    return () => { void server.close() }
  }, 'kb-mcp-server: close on disposal')
  await server.connect(transport)
}
