# Agent Note: dsh-kb 里程碑 2 — 知识包与 kb/injected 主动注入

Status: implemented

[English](2026-08-18-dsh-kb-inject.md) | 中文

## Problem

里程碑 1 已让个人库闭环跑起来——卡片读写、晋升、FTS5 检索与增量采集。里程碑 2 必须交付主动注入：个人 AI 助手在会话启动时按场景获得精选卡片集合（知识包），无需检索步骤。外部设计已定稿产品决策：知识包按场景订阅、不撒网（起步 1-3 个包）；注入必须 100% 到达模型；一切模型可见输入必须能从 session 日志重建；注入记录必须携带*哪些卡片*，供里程碑 3 的记账投影按卡片核算热度。

## Decision

**知识包定义落在 `KbConfig.packs`**（启动文档待决项 7.2：先 Config，workspace 文件化等 web 工作台）。包 = `KnowledgePack { name, tags?, tier?, status?, limit? }`，由 `resolvePacks` 在加载时解析校验——非空且唯一的 name、闭合枚举的 tier/status 成员、正安全整数 limit、非空标签、未知键一律 loud fail。部署配置的包清单本身就是场景订阅："按场景订阅"指部署为自身场景配置相关包；针对任务文本的运行时关键词匹配后置——会话启动时不存在任务文本。

**触发点是 `agent/session-start`，且监听器同步完成。** agent-loop 的 turn 流程在 `agent/pre-step` waterfall **之前**就组装 prompt（渲染 section 文本），因此 pre-step 里的 append 只能进*下一个* step 的请求——单 step 的 turn 永远收不到包。`agent/session-start` 在首个 turn 之前恰好触发一次，在那里 append 对首次组装可见；但 session-start 是 fire-and-forget emit，不 await 监听器，所以选择逻辑不能异步。注入因此通过 `PersonalCardStore.listSync()`（`list()` 的同步孪生，同样的分层遍历与按文件解析失败上报）同步读库。监听器按包 fold 日志（`hasInjectedPack`），resume、fork 或重复发射 session-start 都不会重复注入；无 `cwd` 的会话跳过注入（无可读内容）；匹配零张卡片的包不追加；单个包失败只记 warning 并继续，不阻断 agent 发布。

**`kb/injected` 携带渲染后的内容，而不只是 id。** 载荷 = `{ pack, cardIds, sections: { name, text }[] }`，其中 `sections` 是渲染后的卡片块（标题 / 适用条件 / 核心结论 / 应做 / 不应做 / 可选 反例）。仅凭日志即可重建 prompt section，之后对库的编辑或删除都不会改变回放结果。**不带 `ignorable` 标记**：[session-log 版本机制](../architecture/2026-08-10-session-log-version-mechanism.md)的标记服务于仓库级生成已知词表之外的事件；`kb/injected` 在仓库内 `packages/kb/kb-core/src/types.ts` 声明，`gen-persistence-catalog` 会像 `kb/write`、`kb/promote` 一样把它写进 `KNOWN_SESSION_EVENT_TYPES`，且它是纯信息记录（不改变其余日志的读法）。

**渲染是 prompt section，不是消息。** `inject.ts` 注册 `ctx.systemPrompt.section({ name: 'kb:pack', order: 60, text: (context) => 从 context.agent.session.events fold kb/injected 事件 })`。`kb/injected` 事件是唯一事实源，section 只做渲染。100% 到达：append 在首次组装前同步完成，且该 section 参与之后每一个请求。刻意不用 `agent.inject()`：它排队的消息可能错过已 claim 批次的请求，且 kb-architecture 决策 3 已定"事件渲染进 prompt 组装"为注入机制。

**选择逻辑是纯函数，不是新服务方法。** `pack.ts` 的 `selectPackCards(entries, pack)` 按标签（必须全含）、tier 白名单、status 白名单（缺省排除 `archived`——已归档卡片永不自动注入）过滤，按卡片 id 排序，按 `limit` 截断。`ctx.kb.listCards` 曾考虑并放弃：唯一调用方会是内部选择逻辑，这正是私有能力应避免的反模式。

**kb-inject 模块继续留在 `dsh-kb-core` 单包内**，以源码目录分界：`pack.ts`（包解析、选择、渲染、fold——纯逻辑）与 `inject.ts`（session-start 监听器与 `kb:pack` section 注册），维持启动文档待决项 7.1（模块稳定前不拆包）。

**invariant 伴生包从 session 日志校验 `kb/injected`**：`cardIds` 与 `sections` 非空、每个 section 的 `name`/`text` 非空、section 名按序等于卡片 id——载荷的两个面向不能漂移。

## Alternatives considered

**plan-mode 式 pre-step 触发。** 拒绝：agent-loop 的 turn 流程在 pre-step waterfall 之前渲染 prompt（在 `packages/core/agent-loop/src/agent.ts` 核实），pre-step 里的 append 对当前 step 的请求不可见，只有后续 step 才看得到——单 step turn 什么都收不到，违反 100% 到达。

**异步 session-start 监听器。** 拒绝：`agent/session-start` 是 fire-and-forget emit，返回的 promise 被丢弃，异步选择会与首次组装竞争。真实启动路径让竞争具体化：`dsh --profile headless` 创建 agent 后立即 followup 任务文本，读库几乎必然落后。同步监听器以 agent 创建时一段有界的阻塞换确定性。

**`agent.inject()` 注入渲染消息。** 拒绝：排队消息可能错过已 claim 批次的请求、可能被取消丢弃；架构决策 3 已选事件渲染 prompt 组装；且消息会与事件重复落日志，事件不再是唯一事实源。

**给 `kb/injected` 加 `ignorable: true`。** 拒绝：该标记服务于旧 build 无法知晓的词表；`kb/injected` 与其他仓库内事件一样进入生成的仓库级已知列表，第一方 reader 永远认得它。加上标记反而会掩盖旧 build 的真实词表回归。

**`ctx.kb.listCards` 作为选择查询。** 拒绝：唯一调用方会是内部选择；纯函数 `selectPackCards` 保持 seam 不变，未来 `kb_pack` 工具或工作台出现真实消费者时再包装。

**针对任务文本的场景关键词匹配。** 里程碑 2 拒绝：`agent/session-start` 时没有任务文本；部署配置的包清单就是订阅。按任务匹配需要随 CLI/工作台里程碑出现的任务概念，且会把触发点推回到达分析已否决的 pre-step 路径。

## Consequences

配置了包的部署，其每个会话的每个请求都会在 `kb:pack` section 中带上包内容——这是"注入即上下文"要的恒定每请求 token 成本。session-start 监听器做一次受库规模与包过滤约束的同步读库，记为已知限制。注入按"每会话每包一次"：同一会话内的新任务、会话开始后的库编辑都不会重新注入（重新注入属 govern/recap 里程碑）。resume 与 fork 从日志继承注入，回放仅凭 `kb/injected` 即可逐字节复现 `kb:pack` section。载荷的 `cardIds` 面向让遥测投影（[里程碑 3](2026-08-19-dsh-kb-milestone-3.zh.md) 落地）无需解析渲染文本即可按卡片投影热度。包选择缺省排除已归档卡片，退休内容永不自动注入；显式 `status` 白名单整体覆盖该缺省，里程碑 3 另加可选 `library` 白名单让包横跨两库。
