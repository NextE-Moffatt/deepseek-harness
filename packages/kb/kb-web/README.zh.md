# @deepseek-ai/dsh-kb-web

[English](README.md) | 中文

Web 治理工作台主机侧：`ctx.kbWorkbench`，一个 Remote 服务，暴露某个工作区的合并待复核清单（保鲜 + 复盘盲点）、完整卡片读取、飞轮指标与生命周期动作（晋升 / 归档 / 复活 / 复核）。浏览器侧是 [`@deepseek-ai/dsh-client-ui-kb-workbench`](../../client/ui-kb-workbench/README.md)；[里程碑 5 Agent Note](../../../.agents/notes/implemented/feature/2026-08-19-dsh-kb-milestone-5-workbench-and-mcp.md) 拥有范围决策。

## Service

`ctx.kbWorkbench`（类 `KbWorkbenchService`，默认导出）是 `kbWorkbench` namespace 下的 `TypertRemoteService`。每个 Remote 方法第一个参数是 session（`session` Typert lookup 在线上携带 session id）；工作区根从 `session.header.cwd` 推导。

| 方法 | 行为 |
|---|---|
| `overview(session, today?)` | 合并待复核视图：保鲜复核、未记录的复盘盲点（只检测不记录——检查点队列仍归工具与调度器）、热度账本，以及从同一批数据面投影的五个飞轮指标（注入次数、热度 Top 卡片、晋升总数、待复核、盲点）。 |
| `card(session, id)` | 个人库与团队库中的一张完整卡片及派生质量等级。 |
| `promote(session, id, target, evidence?)` | 晋升迁移（`pending` / `ready`，即 `kb_promote` 子集）+ `kb/promote` 事件。 |
| `archive(session, id)` / `revive(session, id)` | 退役/复活边 + `kb/promote` 事件。 |
| `review(session, id, approved)` | 第二门禁；与 `kb_review` 一样仅通过时追加 `kb/promote`。 |

动作是对既有 `ctx.kb` 方法的薄事件追加包装——工作台不驱动第二状态机，追加进工作台 session 日志的每个 `kb/promote` 都由 `@deepseek-ai/dsh-kb-core` invariant 伴生插件校验。

## Configuration

| 字段 | 默认 | 含义 |
|---|---|---|
| `blindSpotLimit` | `20` | overview 列出的未记录盲点上限。 |
| `topHeatCount` | `3` | 飞轮指标携带的热度 Top 卡片数。 |

非法值加载时大声失败。

## Events

工作台追加与工具相同的 `kb/promote` 事件（携带迁移载荷；被拒的复核不追加），因此人的动作是与工具调用一样可从日志重建的 session 事实。overview 只读既有投影（`kb.freshnessReview`、复盘检查点、热度账本，以及对工作区 session 日志上 `kb/promote` 事件的折叠）——不存在第二事件流。

## Model Experience

### 工作台驱动的 session 事件

#### What the model sees

工作台是人的界面；它的生命周期动作向工作台所在 session 自己的日志追加与工具相同的 `kb/promote` 事件。`kb/promote` 携带迁移载荷（`id`、`from`、`to`、可选 `evidence`）；被拒的复核不追加，与 `kb_review` 完全一致。

#### Token effect

除模型本就读的 session 日志内容外无额外开销；工作台不新增 prompt 片段。

#### KV Cache effect

仅追加；工作台驱动的事件与其他 session 事件一样跟在可复用请求前缀之后。

## Known Limitations and Deferred Work

- **可选组合** —— kb-core、kb-web 与工作台客户端插件通过部署自己的 `cordis.yml` 挂载（见 [kb-web overlay 示例](../../../examples/kb-web/cordis.yml)）；出厂 `dsh-web-app` bundle 不含 kb。
- **无卡片内容编辑** —— 工作台动作集恰好是既有 seam 支持的生命周期迁移；改卡片内容仍是模型任务，走 `kb_write`（新草稿）+ 双门禁。
- **工作台只列盲点不记录** —— 复盘检查点只通过 `kb_recap` 工具与定时任务推进，队列语义不变。
- **IM 通知后置** —— 待复核清单就是人的渠道；IM 渠道带文档化触发条件（真实运维渠道需求）。
