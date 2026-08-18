# Agent Note: dsh-kb 包组设计与里程碑 1 范围

Status: implemented

[English](2026-08-18-dsh-kb-package-group-milestone-1.md) | 中文

## Problem

DeepSeek Harness 目前没有个人知识库能力。外部设计文档（知识库设计方案 v0.5 与 kb 架构设计 v0.3，由实施启动文档引用）已定稿产品决策：个人 + 团队双库、一套卡片规范、从个人草稿到团队引用池的晋升管线、FTS5 优先检索并带显式降级契约、以及映射到 dsh 扩展点的插件族。里程碑 1 必须让个人库闭环真正跑起来——Inbox → 草稿卡片 → 检索——以 dsh 插件 bundle 形态落地，且每次状态变更都落为可回放的 session 事件。

## Decision

**新增一个包组 `packages/kb/`，内含唯一 workspace 包 `@deepseek-ai/dsh-kb-core`**，位于 `packages/kb/kb-core/`。按启动文档"先单包、稳定后再拆"的选择（启动文档待决项 7.1），模块边界先以源码目录保持（`card/`、`store/`、`lifecycle/`、`search/`、`ingest/`、`tools/`）；组目录是纯容器，自带 README 并在 [packages 一览](../../../../packages/README.md) 注册，`tsconfig.base.json` 的 `@deepseek-ai/dsh-*` 路径通配加入 `./packages/kb/*/src`。

**卡片规范逐字遵循设计 §4.2 模板。** 卡片 = Markdown + YAML front matter：front matter 携带 `id`（品牌类型 `CardId`，格式 `{type}-YYYYMMDD-{seq}`）、`type`（`rule` | `case` | `howto` | `decision`）、`title`，以及中文键 库 / 状态 / 适用条件 / 来源 / 责任人 / 有效期 / 标签；正文承载 核心结论、应做、不应做，以及可选的 反例 / 踩坑记录。中文键是设计定稿的用户可见数据格式，因此 TypeScript 的 `Card` 类型逐字镜像为属性名（`card.适用条件`）。应做 / 不应做 节必须存在但模型层允许空列表；`kb_write` 工具要求每侧至少一项，因为它是"撰写规范卡片"的路径。个人草稿的 来源 可选。有效期缺省时按 `now + cardTtlDays` 计算。

**个人库存储**位于 `<session cwd>/kb/cards/<tier>/<id>.md`，分层 P0–P3（`cardsPath` 配置，默认 `kb/cards`）。解析对未知 front matter 键、缺失必填字段、非法日期、未知枚举值一律 loud fail；写路径对 id 冲突 loud fail。无法解析为卡片的文件在 store 枚举时被忽略（个人库人可手编；索引按文件报告解析失败）。

**晋升状态机**是闭合链 `draft → pending → ready → archived → revived`，`revived → archived` 允许复活后再次归档。`revived` 是"已恢复活跃"状态，与从未归档的 `ready` 区分，供治理使用。`lifecycle.ts` 持有转移表；`kb_promote` 只暴露晋升子集（目标 `pending` 与 `ready`）。

**状态变更必须入日志。** `kb/write` 与 `kb/promote` 通过 `src/types.ts` 里的 declaration merging 扩展 `SessionEventMap`；工具在文件操作成功后追加事件。采集生成的卡片是文件事实（无模型可见面），不追加事件；其 来源 记录源文件路径。

**kb-search** 是 `CardIndex`：基于 `node:sqlite`（`DatabaseSync`，FTS5 `unicode61` + BM25），另配普通 `cards` 表做结构化过滤（`type` / 状态 / 层级 / 标签）。索引位于 `kb/.kb-index.sqlite`（`indexPath` 配置），按库根目录打开、服务销毁时关闭，每次检索前重新解析库并按卡片差异重写（里程碑 1 规模下解析成本与库大小线性）。查询词逐词加引号后 AND 连接，避免 FTS5 语法错误导致检索失败；中日韩/假名连续段在索引与查询两侧都按字切分（每字一个 token，多字查询变成相邻短语），子串检索无需分词词典。降级契约显式化：索引无法打开时，检索返回确定性扫描模式结果（`mode: 'scan'`，同一套过滤 + 说明），绝不生成无依据答案。

**工具**：`kb_search`、`kb_read`、`kb_write`、`kb_promote` 在服务构造器中注册到 `ctx.tools`。描述用中文，因为卡片词汇是中文。渲染意图提前定死：`kb_write` 调用/结果为 `generic`，id 已知时带 `locations`；`kb_read`、`kb_promote` 为 `generic`；`kb_search` 结果为 `search` 卡片类型（`shape: 'paths'`，卡片文件路径，`truncated`/`total` 来自 `presentationMeta`）。

**增量采集最小实现**是服务方法 `importDir`：递归扫描源目录中的卡片形 `*.md`，检查点文件 `kb/.ingest-state.json` 按源路径记录（mtime+size 命中即跳过），按卡片 id 去重（新导入落为 `draft`；重复导入保留既有状态）。非卡片原始文件跳过并计数。经 `ctx.jobs` 调度与原始笔记包装推迟到复盘/治理里程碑。

**插件形态**是 Cordis 服务（`KbService extends Service`，默认导出，注册为 `ctx.kb`），`Config` 字段 `cardsPath`、`indexPath`、`cardTtlDays`（默认 90）在加载时解析、非法值 loud fail。类型词汇位于 [kb 子系统页](../../../../docs/subsystems/kb.md)（含生成的 cordis-surface 区域）；工具 schema 渲染进 [tool catalog](../../../../docs/tool-catalog.md#deepseek-aidsh-kb-core)，`kb/*` 事件载荷进 [persistence catalog](../../../../docs/persistence-catalog.md#kbpromote--log-only)。`./invariant` 伴生包从 session 日志校验 `kb/*` 载荷形状与转移合法性；它在本地镜像闭合值集与转移表而不 import 运行时模块，因为 built 伴生 bundle 不能依赖包声明的 `files` 列表未发布的共享 chunk。

**验证**为各模块单测 + 一个 Loader 组合测试：用测试专用 `cordis.yml` 启动，在真实 workspace 目录里跑验收链（`kb_write` 建草稿卡片 → `kb_search` 检索到 → `kb_promote` 触发状态机 → 从 session 日志回放 `kb/*` 事件），符合仓库测试策略。

## Alternatives considered

**现在就拆成多个包。** 已否决：模块边界（search、tools、inject、govern）尚未稳定到可以冻结为包接缝；启动文档"先单包、稳定后拆"避免投机式改名。

**英文 front matter 键 + 映射层。** 已否决：设计 §4.2 模板是定稿的用户可见规范；键翻译表是第二事实源，容易与模板漂移。

**应做 / 不应做 处处严格非空。** 已否决：采集导入与人手编辑的卡片可能合理地缺一侧；由写作工具在规范意图所在处强制非空。

**`kb_write` 要求模型提供 `id`。** 已否决：序号生成是存储职责（`{type}-{YYYYMMDD}-{seq}`，取该前缀现存最大序号 +1）；要求模型提供会把冲突变成模型的问题。

**采集时把原始笔记包装成草稿卡片。** 已否决：那会从任意文本编造 核心结论 / 应做 内容。原始笔记转卡片归复盘/蒸馏里程碑。

**里程碑 1 就上 `ctx.jobs` 周期采集。** 已否决：目前没有配置的数据源；先交付服务接缝，调度随真实连接器落地。

## Consequences

单包会随模块稳定前持续变大，卡片模型里的中文属性名在本仓库也少见——两者都是有意为之（启动文档决策 1 与 7.1）。检索每次同步会重新解析全部卡片文件；在里程碑 1 规模下可接受，已记为限制。P0/P1 层级经 `kb_write` 接受任意卡片形态；层级语义（Inbox 周清空、项目笔记）是里程碑 1 之外的产品工作。知识包与注入在里程碑 2 落地（[注入 Note](2026-08-18-dsh-kb-inject.zh.md)）；团队库、治理与记账在里程碑 3 落地（[里程碑 3 Note](2026-08-19-dsh-kb-milestone-3.zh.md)）；复盘、Web 工作台、MCP 按路线图继续推迟。`ctx.kb` 接缝、`kb/*` 事件与 `kb-search` 接口正是这些里程碑要基于的扩展点。验收链——写入、检索、晋升、回放——在真实 workspace 内可跑通，且不改 agent-loop。
