/**
 * kb-skills: the methodology skills registered on the skills registry —
 * `kb-card-writing` (the §4.3 checklist and card template), `kb-recap-flow`
 * (the mode-B recap and distillation steps), and `kb-pack-building` (the
 * knowledge-pack filter semantics). The skill bodies interpolate the parser's
 * own constants (types, tiers, statuses, libraries), so the card-spec facts
 * the skills state cannot drift from the code — the single source stays the
 * implementation, never a hand-copied second copy. Registration is optional:
 * a context without a `skills` service logs one loud error per context and
 * skips.
 * @module @deepseek-ai/dsh-kb-core/skills
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { CARD_LIBRARIES, CARD_STATUSES, CARD_TIERS, CARD_TYPES } from './card.ts'

/** The card-writing skill's name on the skills registry. */
export const CARD_WRITING_SKILL = 'kb-card-writing'
/** The recap-flow skill's name on the skills registry. */
export const RECAP_FLOW_SKILL = 'kb-recap-flow'
/** The knowledge-pack-building skill's name on the skills registry. */
export const PACK_BUILDING_SKILL = 'kb-pack-building'

/**
 * The card-writing skill body: the shared card template's structure facts
 * (interpolated from the parser constants) plus the §4.3 quality checklist.
 * @returns the skill's markdown instruction body.
 */
export function cardWritingSkillContent(): string {
  return `# 知识卡片写作规范（dsh-kb）

写一张卡片前先想清楚三件事：这条知识解决什么问题（title）、什么情况下该用（适用条件）、结论是什么（核心结论）。

## 卡片结构

每张卡片是 Markdown + YAML front matter，字段如下：

- id：\`{type}-YYYYMMDD-{seq}\`（如 rule-20250818-001），唯一
- type：${CARD_TYPES.join(' / ')}（rule 规则 / case 案例 / howto 操作 / decision 决策）
- title：一句话说清这条知识解决什么
- 库：${CARD_LIBRARIES.join(' / ')}（personal 个人库 / team 团队库）
- 状态：晋升管线的 ${CARD_STATUSES.join(' → ')}
- 层级目录：${CARD_TIERS.join(' / ')}（P0 Inbox 随手记 / P1 项目笔记 / P2 草稿卡片 / P3 私人经验）
- 适用条件：什么情况下该用——检索命中的关键，要具体到别人/别的 Agent 能判断
- 核心结论：一段话讲完结论
- 应做 / 不应做：可执行的正面/负面动作清单，至少各一项
- 来源：客观证据（MR/事件单/文档链接）；团队卡片必须有，个人草稿可省略
- 责任人：知识负责人
- 有效期：到期重校验日期
- 标签：供知识包订阅分组的标签
- 反例（可选）：真实反例/踩坑记录，比正例更有检索价值

正文用 ## 核心结论 / ## 应做 / ## 不应做 / ## 反例（可选）/ ## 踩坑记录（可选）分节。

## 一条好卡片的检查清单

- 人读一遍能懂，不需要看来源文档
- 「适用条件」写得具体，换个人/换个 Agent 能判断这条适不适用
- 结论可执行（应做/不应做），不是感想
- 团队卡片必须有来源链接（客观信号）；个人草稿可以没有

别把整篇长文直接塞进卡片——长文归团队库 docs/ 文档型存储，卡片才是引用池的载体。`
}

/**
 * The recap-flow skill body: the mode-B steps — when to run the recap scan,
 * how to judge blind spots, how to distill them into draft cards, and how the
 * drafts continue into the dual-gate promotion pipeline.
 * @returns the skill's markdown instruction body.
 */
export function recapFlowSkillContent(): string {
  return `# 知识复盘流程（dsh-kb 模式 B：用即积累）

## 何时复盘

定期（或会话有沉淀价值时）运行 kb_recap 扫描本 workspace 的会话日志，找出盲点：消费过知识库（会话有 kb/injected 注入）但没有写任何卡片（无 kb/write）的会话。每个盲点只浮出一次；会话日志增长后才会再次列出。定时任务配置了 recapIntervalDays 时会自动产出复盘清单。

## 复盘步骤

1. 运行 kb_recap 得到盲点清单：每个条目给出会话 id、发生时间、消费过的卡片 id 和会话摘录
2. 逐个判断：这次会话里有没有值得沉淀的新知识？没有就跳过——敢于不沉淀，知识密度比体量重要
3. 值得沉淀的：对照条目里的消费卡片 id 检查是否已有卡片覆盖（可用 kb_search 复核）；确实缺的，用 kb_write 蒸馏成 P2 草稿卡片（tier: P2），来源写明对应的会话或证据
4. 草稿卡片随后走既有晋升管线：满足客观信号（上线/交付/关闭/评审/复用）后，用 kb_gate_check 检查、kb_team_promote 晋升团队库 pending、kb_review 复核进 ready 引用池

复盘只负责找出盲点并给出蒸馏材料；写不写、写什么由模型判断后通过 kb_write 完成，复盘本身不伪造卡片内容。`
}

/**
 * The knowledge-pack-building skill body: how to organize tags, tiers,
 * libraries, and statuses into the pack filters the session-start injection
 * subscribes to.
 * @returns the skill's markdown instruction body.
 */
export function packBuildingSkillContent(): string {
  return `# 知识包构建（dsh-kb）

知识包 = 按场景订阅的卡片集合，配置在 KbConfig.packs，会话启动时注入。配置的包列表就是场景订阅——包按场景组织，别撒网。

## 包过滤字段

- name：包名，模型可见的包头；唯一、非空
- tags：必须全部命中（AND 语义）——按场景打标签是包构建的主要手段，标签要可判定的场景词（如"告警""巡检"）
- tier：个人库层级白名单（${CARD_TIERS.join(' / ')}）；只作用于个人库条目
- library：库白名单（${CARD_LIBRARIES.join(' / ')}）；缺省时两库都可选
- status：状态白名单（${CARD_STATUSES.join(' / ')}）；缺省时 archived 默认排除
- limit：每会话注入条数上限

## 构建要点

- 起步 1-3 个包，按最高频场景组织
- 标签保持一致：同一个场景用同一组标签词，别让同义标签把卡片拆散
- 引用池（团队 ready 卡片）用 library: [team] 或 status: [ready] 订阅；个人草稿用 tier 白名单控制
- 卡片写好后检查标签是否落在某个包的订阅内——包匹配不到的卡片不会注入，也就不会产生消费热度`
}

/** Contexts that already logged the "skills unavailable" error. */
const warnedContexts = new WeakSet<object>()

/**
 * Register the three kb methodology skills on the skills registry. Optional:
 * a context without a `skills` service logs one loud error per context and
 * skips — the registry is a consumer choice, never a kb requirement.
 * @param ctx - registrant context carrying the skills service.
 */
export function registerKbSkills(ctx: Context): void {
  const skills = ctx.get('skills') as { register(skill: SkillRegistration): () => void } | undefined
  if (skills === undefined) {
    if (!warnedContexts.has(ctx)) {
      warnedContexts.add(ctx)
      ctx.logger.error('dsh-kb-core: no skills service is mounted; kb methodology skills are unavailable (mount @deepseek-ai/dsh-skill)')
    }
    return
  }
  skills.register({
    name: CARD_WRITING_SKILL,
    description: 'dsh-kb 知识卡片写作规范：卡片模板、字段与质量检查清单',
    whenToUse: '写 kb_write 卡片前、复盘蒸馏草稿时、评审卡片时',
    source: 'runtime',
    content: cardWritingSkillContent(),
  })
  skills.register({
    name: RECAP_FLOW_SKILL,
    description: 'dsh-kb 知识复盘流程：kb_recap 盲点扫描、蒸馏草稿、双门禁晋升',
    whenToUse: '运行 kb_recap 后判断盲点与蒸馏草稿时',
    source: 'runtime',
    content: recapFlowSkillContent(),
  })
  skills.register({
    name: PACK_BUILDING_SKILL,
    description: 'dsh-kb 知识包构建：tags / tier / library / status 订阅过滤的组织方式',
    whenToUse: '配置 KbConfig.packs、为场景组织知识包订阅时',
    source: 'runtime',
    content: packBuildingSkillContent(),
  })
}
