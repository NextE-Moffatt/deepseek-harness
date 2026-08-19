/**
 * The milestone-4 model-facing tool set: `kb_recap` — the on-demand recap
 * scan. The tool runs the shared scan (detect the workspace's unrecorded
 * blind spots, list up to `limit`, record the listed positions into the
 * checkpoint), appends the `kb/recap` session event when positions were
 * recorded, and returns the listed blind spots with their conversation
 * excerpts — the distillation material the model turns into draft cards
 * through `kb_write`. Descriptions are Chinese because the card vocabulary is
 * Chinese.
 * @module @deepseek-ai/dsh-kb-core/recap-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { KbService } from './index.ts'
import {
  DEFAULT_RECAP_LIMIT, recapEventPayload, renderRecapList,
  type BlindSpotEntry,
} from './recap.ts'
import { sessionRoot } from './tools.ts'

/**
 * Register the recap tool set on the context's tool registry.
 * @param ctx - registrant context carrying the tool registry.
 * @param kb - the kb service the tool delegates to.
 */
export function registerRecapTools(ctx: Context, kb: KbService): void {
  ctx.tools.register(defineTool({
    name: 'kb_recap',
    description: '知识复盘扫描：找出本 workspace 中"消费过知识库但未沉淀卡片"的会话盲点'
      + '（有 kb/injected 注入但无 kb/write），列出最近发生的盲点及其会话摘录。'
      + '每个盲点只浮出一次；模型据此用 kb_write 把值得沉淀的内容蒸馏成 P2 草稿卡片，'
      + '之后可走 kb_gate_check / kb_team_promote 晋升。',
    parameters: {
      limit: {
        type: 'integer',
        description: `本次列出条数上限，1-50，默认 ${DEFAULT_RECAP_LIMIT}；未列出的盲点下次扫描继续列出`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scanDate: { type: 'string', required: true },
          total: { type: 'integer', required: true },
          listed: { type: 'integer', required: true },
          entries: {
            type: 'array', required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                at: { type: 'string', required: true },
                consumed: { type: 'array', required: true, items: { type: 'string' } },
                excerpt: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderRecapList(
          value.scanDate,
          value.total,
          value.entries as unknown as BlindSpotEntry[],
        ),
      }],
    },
    async execute(args, exec) {
      const { root, agent } = sessionRoot(exec)
      const limit = args.limit ?? DEFAULT_RECAP_LIMIT
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new Error(`limit must be an integer between 1 and 50, got ${JSON.stringify(limit)}`)
      }
      const result = await kb.recap(root, limit)
      if (result.recorded.length > 0) {
        agent.session.append('kb/recap', recapEventPayload(result))
      }
      return {
        scanDate: result.scanDate,
        total: result.total,
        listed: result.entries.length,
        entries: result.entries,
      }
    },
    presentCall: args => ({ card: 'generic', title: `知识复盘扫描${args.limit === undefined ? '' : `（列出 ${args.limit} 条）`}`, kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: '复盘扫描结果', content: result.content }),
  }))
}
