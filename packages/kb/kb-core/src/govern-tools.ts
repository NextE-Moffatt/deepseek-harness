/**
 * The milestone-3 model-facing tool set: `kb_gate_check` (first gate,
 * evidence → PASS/BLOCK), `kb_team_promote` (personal draft → team pending,
 * gate enforced), `kb_team_read`, `kb_review` (second gate, human review),
 * `kb_archive` / `kb_revive` (state-machine retire/restore edges), `kb_team_commit`
 * / `kb_team_status` (the draft → review → commit git flow), and `kb_freshness`
 * (the pending-review list). Descriptions are Chinese because the card
 * vocabulary is Chinese. The write tools are approval-gated through the
 * `tools/pre-execute` waterfall when `KbConfig.teamWriteApproval` is set; the
 * tools append the `kb/*` session events after the underlying operation
 * succeeds.
 * @module @deepseek-ai/dsh-kb-core/govern-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { serializeCard } from './card.ts'
import { todayString } from './date.ts'
import { evaluateGate, renderReviewList, type ReviewEntry } from './govern.ts'
import type { KbService } from './index.ts'
import { applyTransition, cardReadValue, optionalText, requiredText, sessionRoot } from './tools.ts'
import type { Card, CardId } from './types.ts'

/** The team-library write tools routed through the approval `ask` gate. */
const TEAM_WRITE_TOOLS = new Set(['kb_team_promote', 'kb_review', 'kb_archive', 'kb_revive', 'kb_team_commit'])

/**
 * Register the team-write approval gate: a `tools/pre-execute` waterfall
 * listener that returns `{ kind: 'ask' }` for the write tool set whenever
 * `KbConfig.teamWriteApproval` is set. The tool runtime routes `ask` through
 * the composed approval service (`allowed-once` runs, anything else denies,
 * and a missing approval service denies) — the harness owns permissions, kb
 * only declares which operations are sensitive. Read-only tools and tools on
 * other sets delegate through `next()`.
 * @param ctx - registrant context carrying the tool runtime.
 * @param kb - the kb service holding the approval config.
 */
export function registerTeamWriteApproval(ctx: Context, kb: KbService): void {
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next) => {
    if (!kb.config.teamWriteApproval) return next()
    if (!TEAM_WRITE_TOOLS.has(exec.name)) return next()
    return { kind: 'ask', reason: `${exec.name} 会写入团队共享知识库，需人工审批` }
  })
}

/** Trim a non-empty evidence list, failing on blank items. */
function evidenceList(name: string, value: readonly string[]): string[] {
  return value.map((item, index) => {
    const trimmed = item.trim()
    if (trimmed === '') throw new Error(`${name} item ${index} must be a non-empty string`)
    return trimmed
  })
}

/** Project a review entry for tool output (same fields; the schema constrains the enums). */
function toOutputEntry(entry: ReviewEntry): ReviewEntry {
  return entry
}

/**
 * Register the milestone-3 tool set on the context's tool registry.
 * @param ctx - registrant context carrying the tool registry.
 * @param kb - the kb service the tools delegate to.
 */
export function registerGovernTools(ctx: Context, kb: KbService): void {
  ctx.tools.register(defineTool({
    name: 'kb_gate_check',
    description: '第一道门（客观信号门）：检查一张个人库草稿卡片是否具备晋升团队库的条件——来源链接、可执行清单（应做/不应做）、非空客观信号证据。工具只做结构性核验（PASS/BLOCK + 原因）；证据的真实性由提交者负责并随工具调用记录。',
    parameters: {
      id: { type: 'string', required: true, description: '个人库草稿卡片 id（如 rule-20250818-001）' },
      /* jscpd:ignore-start */
      evidence: {
        type: 'array', required: true, items: { type: 'string' },
        description: '客观信号说明（上线记录/MR/事件单号/评审结论/复用次数），至少一项',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          verdict: { type: 'string', required: true, enum: ['PASS', 'BLOCK'] },
          reasons: { type: 'array', required: true, items: { type: 'string' } },
          evidenceCount: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `第一道门（客观信号）：${value.verdict}${value.reasons.length === 0 ? '' : `\n原因：\n${value.reasons.join('\n')}`}`,
      }],
    },
    async execute(args, exec) {
      const { root } = sessionRoot(exec)
      const evidence = evidenceList('evidence', args.evidence)
      const card = await kb.personalCard(root, args.id as CardId)
      const verdict = evaluateGate(card?.card, evidence)
      return { verdict: verdict.verdict, reasons: verdict.reasons, evidenceCount: evidence.length }
    },
    presentCall: args => ({ card: 'generic', title: `门禁检查 ${args.id}`, kind: 'other', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: '门禁结论', content: result.content }),
  }))

  ctx.tools.register(defineTool({
    name: 'kb_team_promote',
    description: '晋升个人库草稿卡片到团队库（第一道门落地）：卡片进入团队库 cards/，状态变为 pending，等待第二道门复核。工具内部强制执行门禁规则（来源/清单/证据不满足则失败并列出原因）；写入后可用 kb_team_status 查看、kb_team_commit 提交。',
    parameters: {
      id: { type: 'string', required: true, description: '个人库草稿卡片 id（如 rule-20250818-001）' },
      /* jscpd:ignore-end */
      evidence: {
        type: 'array', required: true, items: { type: 'string' },
        description: '客观信号说明（上线记录/MR/事件单号/评审结论/复用次数），至少一项',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          status: { type: 'string', required: true },
          path: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已晋升团队库 ${value.id}：draft → ${value.status}（${value.title}，${value.path}）`,
      }],
    },
    async execute(args, exec) {
      const { root, agent } = sessionRoot(exec)
      const evidence = evidenceList('evidence', args.evidence)
      const promoted = await kb.promoteToTeam(root, args.id as CardId, evidence)
      agent.session.append('kb/promote', {
        id: promoted.card.id,
        from: 'draft',
        to: 'pending',
        evidence: evidence.join('；'),
      })
      agent.session.append('kb/team-join', {
        id: promoted.card.id,
        path: promoted.path,
        status: 'pending',
      })
      return {
        id: promoted.card.id,
        title: promoted.card.title,
        status: promoted.card.状态,
        path: promoted.path,
      }
    },
    presentCall: args => ({ card: 'generic', title: `晋升团队库 ${args.id}`, kind: 'other', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: '已晋升团队库', content: result.content }),
  }))

  ctx.tools.register(defineTool({
    name: 'kb_team_read',
    description: '按 id 读取一张团队库卡片（front matter + 正文），返回完整内容。',
    parameters: {
      id: { type: 'string', required: true, description: '卡片唯一 id（如 rule-20250818-001）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          /* jscpd:ignore-start */
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
          /* jscpd:ignore-end */
          path: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `团队卡片 ${value.id}（${value.状态}，${value.path}）：\n\n${serializeCard(value as unknown as Card)}`,
      }],
    },
    async execute(args, exec) {
      const info = await kb.teamRead(sessionRoot(exec).root, args.id as CardId)
      return cardReadValue(info.card, info.path)
    },
    presentCall: args => ({ card: 'generic', title: `读团队卡片 ${args.id}`, kind: 'other', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: '团队卡片内容', content: result.content }),
  }))

  ctx.tools.register(defineTool({
    name: 'kb_review',
    description: '第二道门（人复核）：复核一张团队库 pending 卡片。approved=true 时卡片进入 ready（引用池，可被团队知识包订阅注入）；approved=false 时不改变状态，卡片保持 pending 等待补充证据后再次复核。只有在人复核后再调用本工具。',
    parameters: {
      id: { type: 'string', required: true, description: '团队库卡片 id（如 rule-20250818-001）' },
      approved: { type: 'boolean', required: true, description: '复核是否通过' },
      note: { type: 'string', description: '复核意见（可选）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          status: { type: 'string', required: true },
          changed: { type: 'boolean', required: true },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.changed
          ? `已复核通过 ${value.id}：pending → ready，已进入引用池（${value.title}）${value.note === undefined ? '' : `；意见：${value.note}`}`
          : `复核未通过 ${value.id}：保持 pending，可补充证据后重新复核（${value.title}）${value.note === undefined ? '' : `；意见：${value.note}`}`,
      }],
    },
    async execute(args, exec) {
      const { root, agent } = sessionRoot(exec)
      const note = optionalText(args.note)
      const reviewed = await kb.reviewTeam(root, args.id as CardId, args.approved)
      if (reviewed.changed) {
        agent.session.append('kb/promote', {
          id: reviewed.card.id,
          from: 'pending',
          to: 'ready',
        })
      }
      return {
        id: reviewed.card.id,
        title: reviewed.card.title,
        status: reviewed.card.状态,
        changed: reviewed.changed,
        ...note === undefined ? {} : { note },
      }
    },
    presentCall: args => ({ card: 'generic', title: `复核卡片 ${args.id}：${args.approved ? '通过' : '不通过'}`, kind: 'other', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: '复核完成', content: result.content }),
  }))

  /* jscpd:ignore-start -- the archive/revive pair mirrors kb_promote's transition schema, render, and presentation */
  ctx.tools.register(defineTool({
    name: 'kb_archive',
    description: '归档一张团队库卡片：ready / revived → archived（退场）。保鲜扫描会把"已过期且零引用"的卡片标为归档候选，人工确认后调用本工具。',
    parameters: {
      id: { type: 'string', required: true, description: '团队库卡片 id' },
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
        text: `已归档 ${value.id}：${value.from} → ${value.to}（${value.title}）`,
      }],
    },
    async execute(args, exec) {
      const { root, agent } = sessionRoot(exec)
      return applyTransition(agent, root, args.id as CardId, 'archived', (r, i) => kb.archiveTeam(r, i))
    },
    presentCall: args => ({ card: 'generic', title: `归档卡片 ${args.id}`, kind: 'other', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: '已归档', content: result.content }),
  }))

  ctx.tools.register(defineTool({
    name: 'kb_revive',
    description: '复活一张已归档的团队库卡片：archived → revived（恢复为活跃状态）。保鲜扫描会把"仍有引用热度"的已归档卡片标为复活候选；revived 状态与 ready 不同，治理可区分恢复过的卡片。',
    parameters: {
      id: { type: 'string', required: true, description: '团队库卡片 id' },
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
        text: `已复活 ${value.id}：${value.from} → ${value.to}（${value.title}）`,
      }],
    },
    async execute(args, exec) {
      const { root, agent } = sessionRoot(exec)
      return applyTransition(agent, root, args.id as CardId, 'revived', (r, i) => kb.reviveTeam(r, i))
    },
    presentCall: args => ({ card: 'generic', title: `复活卡片 ${args.id}`, kind: 'other', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: '已复活', content: result.content }),
  }))
  /* jscpd:ignore-end */

  ctx.tools.register(defineTool({
    name: 'kb_team_status',
    description: '查看团队库工作树状态（git status --porcelain）：哪些卡片/文档已改动未提交。人复核草稿后调用 kb_team_commit 提交。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          clean: { type: 'boolean', required: true },
          files: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.clean ? '团队库工作树干净，无待提交变更' : `团队库待提交变更（${value.files.length}）：\n${value.files.join('\n')}`,
      }],
    },
    async execute(_args, exec) {
      const files = await kb.teamStatus(sessionRoot(exec).root)
      return { clean: files.length === 0, files }
    },
    presentCall: () => ({ card: 'generic', title: '团队库状态', kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: '团队库状态', content: result.content }),
  }))

  ctx.tools.register(defineTool({
    name: 'kb_team_commit',
    description: '提交团队库工作树变更（git add -A + commit）：把已复核的草稿落成团队库正式提交。这是"工具生成草稿 → 人复核 → 提交"流程的提交点；提交前先用 kb_team_status 复核变更内容。',
    parameters: {
      message: { type: 'string', required: true, description: '提交说明（如：晋升告警处置标准 rule-20250818-001）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', required: true },
          output: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已提交团队库：${value.message}\n${value.output}`,
      }],
    },
    async execute(args, exec) {
      const message = requiredText('message', args.message)
      const output = await kb.teamCommit(sessionRoot(exec).root, message)
      return { message, output }
    },
    presentCall: args => ({ card: 'generic', title: `提交团队库：${args.message}`, kind: 'other', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: '已提交团队库', content: result.content }),
  }))

  ctx.tools.register(defineTool({
    name: 'kb_freshness',
    description: '知识保鲜扫描：列出已过期与即将过期（默认 14 天内）的卡片，附热度与治理建议（复核续期/待复核/归档/复活候选）。过期且零引用的 ready 卡片建议归档；仍有引用的已归档卡片建议复活。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scanDate: { type: 'string', required: true },
          total: { type: 'integer', required: true },
          /* jscpd:ignore-start */
          overdue: {
            type: 'array', required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                library: { type: 'string', required: true, enum: ['personal', 'team'] },
                status: { type: 'string', required: true },
                grade: { type: 'string', required: true, enum: ['verified', 'pending', 'verify'] },
                有效期: { type: 'string', required: true },
                daysLeft: { type: 'integer', required: true },
                heat: { type: 'integer', required: true },
                recommend: { type: 'string', required: true, enum: ['renew', 'review', 'archive-candidate', 'revive-candidate'] },
              },
            },
          },
          expiringSoon: {
            type: 'array', required: true,
            /* jscpd:ignore-end */
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                library: { type: 'string', required: true, enum: ['personal', 'team'] },
                status: { type: 'string', required: true },
                grade: { type: 'string', required: true, enum: ['verified', 'pending', 'verify'] },
                有效期: { type: 'string', required: true },
                daysLeft: { type: 'integer', required: true },
                heat: { type: 'integer', required: true },
                recommend: { type: 'string', required: true, enum: ['renew', 'review', 'archive-candidate', 'revive-candidate'] },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderReviewList(
          // Schema-declared output types widen the card enums; the entries are ReviewEntry values.
          {
            overdue: value.overdue as unknown as ReviewEntry[],
            expiringSoon: value.expiringSoon as unknown as ReviewEntry[],
            total: value.total,
          },
          value.scanDate,
        ),
      }],
    },
    async execute(_args, exec) {
      const { root } = sessionRoot(exec)
      const review = await kb.freshnessReview(root)
      return {
        scanDate: todayString(),
        total: review.total,
        overdue: review.overdue.map(toOutputEntry),
        expiringSoon: review.expiringSoon.map(toOutputEntry),
      }
    },
    presentCall: () => ({ card: 'generic', title: '知识保鲜扫描', kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: '保鲜扫描结果', content: result.content }),
  }))
}
