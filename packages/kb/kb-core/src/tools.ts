/**
 * The milestone-1 model-facing tool set: `kb_write`, `kb_read`, `kb_search`,
 * `kb_promote`. Descriptions are Chinese because the card vocabulary is
 * Chinese. Render intents: `kb_write` call/result are `generic` with
 * `locations` when the id is known, `kb_read` and `kb_promote` are `generic`,
 * and `kb_search` presents the `search` card kind over card file paths.
 * Tools append the `kb/write` and `kb/promote` session events after the
 * underlying file operation succeeds.
 * @module @deepseek-ai/dsh-kb-core/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CARD_STATUSES, CARD_TIERS, CARD_TYPES, isValidDateString, serializeCard } from './card.ts'
import type { KbService } from './index.ts'
import type { Card, CardId, CardStatus, CardTier } from './types.ts'

/**
 * The calling agent and its session workspace root; fails loud when there is
 * no agent or its session has no cwd. Shared with the govern tool set.
 */
export function sessionRoot(exec: ToolExecution): { root: string; agent: Agent } {
  const agent = exec.agent
  const cwd = agent?.session.header.cwd
  if (agent === undefined || cwd === undefined) {
    throw new Error('kb tools require a calling agent whose session has a workspace (session cwd)')
  }
  return { root: cwd, agent }
}

/** Trim a required string argument, failing on blanks. */
export function requiredText(name: string, value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new Error(`${name} must be a non-empty string`)
  return trimmed
}

/** Trim an optional string argument; blank becomes absent. */
export function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/** Trim a non-empty list argument with at least one item. */
function nonEmptyList(name: string, value: readonly string[]): string[] {
  if (value.length === 0) throw new Error(`${name} must have at least one item`)
  return value.map((item, index) => {
    const trimmed = item.trim()
    if (trimmed === '') throw new Error(`${name} item ${index} must be a non-empty string`)
    return trimmed
  })
}

/**
 * The full-card output value shared by `kb_read` and `kb_team_read`. The
 * generic return lets the caller's schema-derived output type flow through.
 */
/** The personal-tagged read face (kb_read). */
export interface CardReadValueWithTier {
  id: string
  type: string
  title: string
  库: string
  状态: string
  适用条件: string
  核心结论: string
  应做: string[]
  不应做: string[]
  反例?: string
  来源?: string
  责任人: string
  有效期: string
  标签: string[]
  tier: string
  path: string
}

/** The team read face (kb_team_read) — no personal tier. */
export interface CardReadValue {
  id: string
  type: string
  title: string
  库: string
  状态: string
  适用条件: string
  核心结论: string
  应做: string[]
  不应做: string[]
  反例?: string
  来源?: string
  责任人: string
  有效期: string
  标签: string[]
  path: string
}

/** Read one card into its output value; the tier parameter selects the personal face. */
export function cardReadValue(card: Card, path: string, tier: CardTier): CardReadValueWithTier
export function cardReadValue(card: Card, path: string): CardReadValue
export function cardReadValue(card: Card, path: string, tier?: CardTier): CardReadValue | CardReadValueWithTier {
  return {
    id: card.id,
    type: card.type,
    title: card.title,
    库: card.库,
    状态: card.状态,
    适用条件: card.适用条件,
    核心结论: card.核心结论,
    应做: card.应做,
    不应做: card.不应做,
    ...card.反例 === undefined ? {} : { 反例: card.反例 },
    ...card.来源 === undefined ? {} : { 来源: card.来源 },
    责任人: card.责任人,
    有效期: card.有效期,
    标签: card.标签,
    ...tier === undefined ? {} : { tier },
    path,
  }
}

/**
 * Run one lifecycle transition through the promotion state machine and log
 * it: apply the transition, append `kb/promote`, and project the canonical
 * result. Shared by `kb_promote`, `kb_archive`, and `kb_revive`.
 */
export async function applyTransition(
  agent: Agent,
  root: string,
  id: CardId,
  to: CardStatus,
  apply: (root: string, id: CardId) => Promise<{ card: Card; from: CardStatus; path: string }>,
  evidence?: string,
): Promise<{ id: string; from: string; to: string; title: string; path: string }> {
  const result = await apply(root, id)
  agent.session.append('kb/promote', {
    id: result.card.id,
    from: result.from,
    to,
    ...evidence === undefined ? {} : { evidence },
  })
  return {
    id: result.card.id,
    from: result.from,
    to: result.card.状态,
    title: result.card.title,
    path: result.path,
  }
}

/** The safe-file-name id pattern shared with the card parser. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** The replayable `kb_search` presentation payload (the canonical outcome). */
interface SearchMeta {
  mode: 'fts' | 'scan'
  total: number
  hits: Array<{
    id: string
    title: string
    type: string
    status: string
    tier: string
    path: string
    适用条件: string
    标签: string[]
    score: number
  }>
}

/**
 * Register the four milestone-1 tools on the context's tool registry.
 * @param ctx - registrant context carrying the tool registry.
 * @param kb - the kb service the tools delegate to.
 */
export function registerKbTools(ctx: Context, kb: KbService): void {
  ctx.tools.register(defineTool({
    name: 'kb_write',
    description: `写入一张新的个人库草稿卡片（Markdown + YAML front matter）。先想清楚：这条知识解决什么问题（title）、什么时候该用（适用条件）、结论是什么（核心结论）、该做什么/不该做什么（应做/不应做）。id 可省略，自动生成 {type}-YYYYMMDD-{seq}；有效期缺省按配置的 cardTtlDays 计算（当前 ${kb.config.cardTtlDays} 天）。`,
    parameters: {
      tier: {
        type: 'string', required: true, enum: [...CARD_TIERS],
        description: '个人库层级目录：P0 Inbox 随手记 / P1 项目笔记 / P2 草稿卡片 / P3 私人经验',
      },
      id: { type: 'string', description: '卡片唯一 id（格式 {type}-YYYYMMDD-{seq}，如 rule-20250818-001）；缺省自动生成' },
      type: {
        type: 'string', required: true, enum: [...CARD_TYPES],
        description: 'rule 规则 / case 案例 / howto 操作 / decision 决策',
      },
      title: { type: 'string', required: true, description: '一句话说清这条知识解决什么' },
      适用条件: { type: 'string', required: true, description: '什么情况下该用这条——检索命中的关键，要具体到别人/别的 Agent 能判断' },
      核心结论: { type: 'string', required: true, description: '一段话讲完结论' },
      应做: {
        type: 'array', required: true, items: { type: 'string' },
        description: '可执行的正面动作清单，至少一项',
      },
      不应做: {
        type: 'array', required: true, items: { type: 'string' },
        description: '可执行的负面动作清单，至少一项',
      },
      来源: { type: 'string', description: '客观证据（MR/事件单/文档链接）；个人草稿可省略' },
      责任人: { type: 'string', required: true, description: '知识负责人（个人库一般为本人）' },
      有效期: { type: 'string', description: '到期重校验日期 YYYY-MM-DD；缺省按配置的 cardTtlDays 计算' },
      标签: { type: 'array', items: { type: 'string' }, description: '供知识包订阅分组的标签' },
      反例: { type: 'string', description: '可选：真实反例/踩坑记录，比正例更有检索价值' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          type: { type: 'string', required: true },
          tier: { type: 'string', required: true },
          status: { type: 'string', required: true },
          path: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已写入草稿卡片 ${value.id}：${value.title}（${value.status}，${value.path}）`,
      }],
    },
    async execute(args, exec) {
      const tier = args.tier
      const type = args.type
      const title = requiredText('title', args.title)
      const appliesTo = requiredText('适用条件', args.适用条件)
      const conclusion = requiredText('核心结论', args.核心结论)
      const shouldDo = nonEmptyList('应做', args.应做)
      const shouldNotDo = nonEmptyList('不应做', args.不应做)
      const owner = requiredText('责任人', args.责任人)
      const source = optionalText(args.来源)
      const counterExample = optionalText(args.反例)
      const expiresAt = optionalText(args.有效期)
      if (expiresAt !== undefined && !isValidDateString(expiresAt)) {
        throw new Error(`有效期 must be a YYYY-MM-DD calendar date, got ${JSON.stringify(expiresAt)}`)
      }
      const tags = [...new Set((args.标签 ?? []).map((tag, index) => {
        const trimmed = tag.trim()
        if (trimmed === '') throw new Error(`标签 item ${index} must be a non-empty string`)
        return trimmed
      }))]
      if (args.id !== undefined) {
        const id = requiredText('id', args.id)
        if (!ID_PATTERN.test(id)) throw new Error(`id must be a safe file name, got ${JSON.stringify(id)}`)
      }
      const { root, agent } = sessionRoot(exec)
      const result = await kb.writeCard(root, {
        tier,
        ...args.id === undefined ? {} : { id: args.id as CardId },
        type,
        title,
        适用条件: appliesTo,
        核心结论: conclusion,
        应做: shouldDo,
        不应做: shouldNotDo,
        ...counterExample === undefined ? {} : { 反例: counterExample },
        ...source === undefined ? {} : { 来源: source },
        责任人: owner,
        ...expiresAt === undefined ? {} : { 有效期: expiresAt },
        标签: tags,
      })
      agent.session.append('kb/write', {
        id: result.card.id,
        library: 'personal',
        tier,
        status: result.card.状态,
        title: result.card.title,
        path: result.path,
      })
      return {
        id: result.card.id,
        title: result.card.title,
        type: result.card.type,
        tier,
        status: result.card.状态,
        path: result.path,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `写卡片 ${args.id ?? '（自动生成 id）'}`,
      kind: 'other',
      ...args.id === undefined ? {} : { locations: [{ path: `${kb.config.cardsPath}/${args.tier}/${args.id}.md` }] },
    }),
    presentResult: (_args, result) => ({ card: 'generic', title: '卡片已写入', content: result.content }),
  }))

  ctx.tools.register(defineTool({
    name: 'kb_read',
    description: '按 id 读取一张卡片（front matter + 正文），返回完整内容。',
    parameters: {
      id: { type: 'string', required: true, description: '卡片唯一 id（如 rule-20250818-001）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          type: { type: 'string', required: true },
          title: { type: 'string', required: true },
          库: { type: 'string', required: true },
          状态: { type: 'string', required: true },
          适用条件: { type: 'string', required: true },
          核心结论: { type: 'string', required: true },
          应做: { type: 'array', required: true, items: { type: 'string' } },
          不应做: { type: 'array', required: true, items: { type: 'string' } },
          反例: { type: 'string' },
          来源: { type: 'string' },
          责任人: { type: 'string', required: true },
          有效期: { type: 'string', required: true },
          标签: { type: 'array', required: true, items: { type: 'string' } },
          tier: { type: 'string', required: true },
          path: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `卡片 ${value.id}（${value.tier}/${value.状态}，${value.path}）：\n\n${serializeCard(value as unknown as Card)}`,
      }],
    },
    async execute(args, exec) {
      const info = await kb.readCard(sessionRoot(exec).root, args.id as CardId)
      return cardReadValue(info.card, info.path, info.tier)
    },
    presentCall: args => ({ card: 'generic', title: `读卡片 ${args.id}`, kind: 'other', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: '卡片内容', content: result.content }),
  }))

  ctx.tools.register(defineTool({
    name: 'kb_search',
    description: '检索个人知识库：FTS5 全文（BM25）命中的草稿卡片，可按类型/状态/层级/标签过滤。结果真实来自卡片文件；索引不可用时明确降级为全库扫描（mode: scan）。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词（AND 连接，中文/英文均可）' },
      type: {
        type: 'string', enum: [...CARD_TYPES],
        description: '过滤：rule 规则 / case 案例 / howto 操作 / decision 决策',
      },
      status: { type: 'string', enum: [...CARD_STATUSES], description: '过滤：draft / pending / ready / archived / revived' },
      tier: { type: 'string', enum: [...CARD_TIERS], description: '过滤：P0 / P1 / P2 / P3' },
      tags: { type: 'array', items: { type: 'string' }, description: '过滤：卡片须包含全部列出的标签' },
      limit: { type: 'integer', description: '返回条数上限，1-50，默认 10' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true, enum: ['fts', 'scan'] },
          total: { type: 'integer', required: true },
          note: { type: 'string' },
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                type: { type: 'string', required: true },
                status: { type: 'string', required: true },
                tier: { type: 'string', required: true },
                path: { type: 'string', required: true },
                适用条件: { type: 'string', required: true },
                标签: { type: 'array', required: true, items: { type: 'string' } },
                score: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `检索（${value.mode}）命中 ${value.total} 条${value.note === undefined ? '' : `；${value.note}`}\n`
          + value.hits.map(hit => `- [${hit.score.toFixed(2)}] ${hit.id}（${hit.status}/${hit.tier}）${hit.title}`).join('\n'),
      }],
      presentationMeta: (_args, value) => value,
    },
    async execute(args, exec) {
      const limit = args.limit ?? 10
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new Error(`limit must be an integer between 1 and 50, got ${JSON.stringify(limit)}`)
      }
      const query = requiredText('query', args.query)
      return kb.search(sessionRoot(exec).root, {
        query,
        ...args.type === undefined ? {} : { type: args.type },
        ...args.status === undefined ? {} : { status: args.status },
        ...args.tier === undefined ? {} : { tier: args.tier },
        ...args.tags === undefined ? {} : { tags: args.tags.map((tag, index) => {
          const trimmed = tag.trim()
          if (trimmed === '') throw new Error(`tags item ${index} must be a non-empty string`)
          return trimmed
        }) },
        limit,
      })
    },
    presentCall: args => ({ card: 'generic', title: `检索知识库：${args.query}`, kind: 'search', rawInput: args.query }),
    presentResult: (_args, result) => {
      const meta = result.meta as SearchMeta | null | undefined
      // Replay safety: a malformed or older logged meta falls back to generic content.
      if (meta === null || meta === undefined) return { card: 'generic', title: '检索完成', content: result.content }
      return {
        card: 'search',
        shape: 'paths',
        paths: meta.hits.map(hit => hit.path),
        truncated: meta.total > meta.hits.length,
        total: meta.total,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'kb_promote',
    description: '晋升个人库卡片状态（状态机：draft → pending → ready）。draft → pending 需要客观信号（上线/交付/关闭/复用）；pending → ready 表示已复核、可进引用池。团队库卡片不适用：团队库状态变更请用 kb_review / kb_archive / kb_revive。',
    parameters: {
      id: { type: 'string', required: true, description: '卡片唯一 id（如 rule-20250818-001）' },
      target: {
        type: 'string', required: true, enum: ['pending', 'ready'],
        description: '目标状态：pending（待复核）或 ready（复核通过）',
      },
      evidence: { type: 'string', description: '客观信号说明（上线记录/MR/事件单号/复用次数）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          title: { type: 'string', required: true },
          path: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已晋升卡片 ${value.id}：${value.from} → ${value.to}（${value.title}，${value.path}）`,
      }],
    },
    async execute(args, exec) {
      const { root, agent } = sessionRoot(exec)
      const id = args.id as CardId
      const team = await kb.teamCard(root, id)
      if (team !== undefined) {
        throw new Error(`卡片 ${id} 属于团队库（${team.path}）：团队库状态变更请用 kb_review / kb_archive / kb_revive`)
      }
      const target = args.target as CardStatus
      const evidence = optionalText(args.evidence)
      return applyTransition(agent, root, id, target, (r, i) => kb.promote(r, i, target, evidence), evidence)
    },
    presentCall: args => ({ card: 'generic', title: `晋升卡片 ${args.id} → ${args.target}`, kind: 'other', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: '卡片已晋升', content: result.content }),
  }))
}
