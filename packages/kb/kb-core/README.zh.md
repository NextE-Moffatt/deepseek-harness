# dsh-kb-core

[English](README.md) | 中文

个人知识库：位于 session workspace 内的 Markdown + YAML 知识卡片库，带 FTS5 检索、晋升状态机、`kb_write` / `kb_read` / `kb_search` / `kb_promote` 工具与会话启动时的知识包注入。设计：[dsh-kb 包组设计与里程碑 1 范围](../../../.agents/notes/implemented/feature/2026-08-18-dsh-kb-package-group-milestone-1.md) 与 [知识包与 kb/injected 注入](../../../.agents/notes/implemented/feature/2026-08-18-dsh-kb-inject.md)。

## Service

`ctx.kb`（类 `KbService`，默认导出）持有库的接缝：

| 方法 | 行为 |
|---|---|
| `writeCard(root, input)` | 写入新的个人库草稿卡片；缺省生成 `{type}-YYYYMMDD-{seq}` id，有效期缺省按 `now + cardTtlDays` 计算。 |
| `readCard(root, id)` | 跨层级读取一张卡片；不存在时抛错。 |
| `search(root, request)` | FTS5 BM25 检索 + 结构化过滤；索引无法打开时显式降级为 `mode: 'scan'`。 |
| `promote(root, id, target, evidence?)` | 校验状态机、重写卡片文件并返回新状态。 |
| `importDir(options)` | 增量采集：从源目录导入卡片形 `*.md`，带检查点与去重。 |

服务方法不持有 session；`kb/*` session 事件由工具追加。后续模块（治理、复盘）复用同一接缝。

## Configuration

| 字段 | 默认 | 含义 |
|---|---|---|
| `cardsPath` | `kb/cards` | 相对 session workspace 根目录的库路径；P0–P3 为子目录，卡片文件为 `<id>.md`。 |
| `indexPath` | `kb/.kb-index.sqlite` | 相对 workspace 根目录的 FTS5 索引库路径。 |
| `cardTtlDays` | `90` | 有效期缺省时加算的天数。 |
| `packs` | `[]` | 会话启动时注入的知识包；见 [Knowledge packs](#knowledge-packs)。 |

非法配置在加载时 loud fail。

## Card spec

卡片遵循统一模板（设计 §4.2）：YAML front matter 含 `id` / `type`（`rule` | `case` | `howto` | `decision`）/ `title` / 库 / 状态 / 适用条件 / 来源 / 责任人 / 有效期 / 标签，正文含 核心结论 / 应做 / 不应做 / 反例 / 踩坑记录。中文键是定稿的用户可见格式，并逐字镜像为 TypeScript 属性名。解析对未知键、缺失必填字段、非法日期与未知枚举值 loud fail；应做 / 不应做 节对导入卡片允许为空，但 `kb_write` 要求每侧至少一项。

## Lifecycle

晋升状态机为 `draft → pending → ready → archived → revived`，`revived → archived` 可再归档；`kb_promote` 只暴露晋升子集（目标 `pending` 与 `ready`）。`revived` 是"已恢复活跃"状态，与从未归档的 `ready` 区分。

## Events

`kb/write`（工具写入卡片文件）、`kb/promote`（状态流转）与 `kb/injected`（一次知识包注入）扩展 `SessionEventMap`，均在底层操作成功后追加，模型可见面可从 session 日志回放。

## Knowledge packs

知识包 = 在 `agent/session-start` 注入到每个 agent 会话的订阅卡片集合，在 `KbConfig.packs` 下配置为 `{ name, tags?, tier?, status?, limit? }`（加载时校验：非空唯一 name、闭合枚举成员、正整数 limit）。会话启动时监听器同步读库，按包选择卡片（标签必须全含、tier/status 白名单、缺省排除 `archived`、按 id 升序、按 `limit` 截断），每包追加一条携带渲染卡片节的 `kb/injected` 事件。`kb:pack` prompt section 为每个请求 fold 这些事件，注入内容无需检索步骤即可到达首个模型请求，且仅凭日志即可逐字节回放。注入按"每会话每包一次"（以日志 fold 为守卫）；无 workspace 的会话跳过注入，零命中卡片不追加，单包失败记日志并继续。载荷的 `cardIds` 面向是记账投影按卡片核算热度的记录。

## Extension points

- **检索后端**：`CardIndex`（FTS5 `unicode61`、BM25、按库根目录一个库）可替换；降级契约（`mode: 'scan'` + 说明，绝不编造结果）是接口的一部分。中文按字切分，子串查询无需分词词典。
- **采集接缝**：`importDir` 是模式 E 的最小实现；`ctx.jobs` 调度与原始笔记包装随真实连接器落地。
- **包选择**：`selectPackCards`（纯函数）是订阅过滤；未来 `kb_pack` 工具或 web 工作台出现真实消费者时再包装。

## Model Experience

### Tool schemas

#### What the model sees

模型看到的是 [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-kb-core) 中的生成 schema：`kb_write`（tier / type / title / 适用条件 / 核心结论 / 应做 / 不应做 / 来源 / 责任人 / 有效期 / 标签 / 反例，`id` 可选）、`kb_read`（`id`）、`kb_search`（`query` + 可选 `type` / `status` / `tier` / `tags` / `limit`）、`kb_promote`（`id`、`target: pending|ready`、可选 `evidence`）。`kb_write` 的描述内嵌配置的 `cardTtlDays`。

#### Token effect

工具可见的每个请求都有固定的 schema 成本。

#### KV Cache effect

定义与可见性不变时前缀稳定；插件生命周期可能使这些 schema 的复用失效。

### Tool-call results and session events

#### What the model sees

`kb_write` 返回 `{ id, title, type, tier, status: draft, path }` 并记录 `kb/write` 事件；`kb_read` 返回完整卡片 + 层级与路径；`kb_search` 返回 `{ mode: 'fts' | 'scan', total, note?, hits }`，命中始终是真实卡片文件，扫描模式带降级说明；`kb_promote` 返回 `{ id, from, to, title, path }` 并记录 `kb/promote` 事件。稳定失败信息：`Error: card not found: <id>`、`Error: invalid card transition <from> → <to> (...)`。

#### Token effect

结果大小随命中数或卡片字段增长；调用参数保留至压缩。

#### KV Cache effect

追加式；新可见内容跟在可复用请求前缀之后，不使既有 KV-cache 条目失效。

### Knowledge-pack injection

#### What the model sees

配置了包的部署，每个请求都携带 `kb:pack` system-prompt section：每个注入包一个 `## 知识包：<name>` 块，每张卡片一个 `### <id>` 标题 + 渲染后的知识字段（标题 / 适用条件 / 核心结论 / 应做 / 不应做 / 可选 反例）。治理元数据（库 / 状态 / 责任人 / 有效期 / 标签）不渲染。

#### Token effect

成本 = 注入卡片渲染的总和；注入后（每会话每包一次）在会话内恒定。

#### KV Cache effect

注入包不变时前缀稳定；该 section 跟在可复用请求前缀之后，不使既有 KV-cache 条目失效。

## Known Limitations and Deferred Work

- **仅个人库**——团队库（共享 git 仓库的 `cards/` + `docs/`）、治理、记账、复盘、Web 工作台与 MCP 暴露按路线图推迟到里程碑 1 之后。
- **检索每次同步重新解析全库**——每次 `search` 都重读并重解析所有卡片文件；索引写入按 mtime/size 差异更新，但解析成本与库大小线性。
- **原始笔记采集推迟**——`importDir` 只导入卡片形文件并计数跳过原始文件；笔记转卡片归复盘/蒸馏里程碑，`ctx.jobs` 调度等待真实连接器。
- **中文检索按字切分**——FTS 索引将中文按字拆开以支持子串查询，无需分词词典；排序与短语语义与分词检索不同，单字查询会命中所有含该字的卡片。
- **文件写入非原子**——卡片写入与采集检查点均为直接写入；中途崩溃可能留下半截文件，store 会将其报告为解析失败。
- **会话启动时同步读库注入**——`agent/session-start` emit 不 await 监听器且首个 prompt 组装紧随其后，选择逻辑使用 store 的同步路径；读取受库规模与包过滤约束。
- **注入按"每会话每包一次"**——同一会话内的新任务与会话开始后的库编辑不会重新注入；包没有运行时场景匹配（配置的包清单就是订阅），workspace 文件化包定义等待 web 工作台。
