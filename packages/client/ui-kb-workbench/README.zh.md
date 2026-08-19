# @deepseek-ai/dsh-client-ui-kb-workbench

[English](README.md) | 中文

知识库治理工作台，浏览器侧：设置页的一个 section（id `kb-workbench`，导航文案 知识库），渲染合并待复核清单（保鲜 + 复盘盲点）、卡片详情、生命周期动作、内容编辑表单与飞轮看板。主机侧是 [`@deepseek-ai/dsh-kb-web`](../../kb/kb-web/README.md)；[里程碑 5 Agent Note](../../../.agents/notes/implemented/feature/2026-08-19-dsh-kb-milestone-5-workbench-and-mcp.md) 拥有范围决策，[里程碑 7 Agent Note](../../../.agents/notes/implemented/feature/2026-08-19-dsh-kb-milestone-7-doc-import-and-workbench-edit.md) 增加编辑面。

## Surface

部署组合本插件后（见 [kb-web overlay 示例](../../../examples/kb-web/cordis.yml)），section 出现在 web 设置面板中：

- **飞轮看板** —— 五个起步指标（注入次数、晋升总数、待复核、盲点、热度 Top 卡片），每个数字都是主机对 `kb/*` 事件或其持久化文件的投影；工作台不持有第二事件流。
- **待复核清单** —— 保鲜条目（已过期 / 即将过期）与未记录复盘盲点（含摘录与消费卡片链接）。
- **卡片详情** —— 任意复核行、热度条目或盲点消费卡片打开的一张完整卡片的全部知识字段。
- **生命周期动作** —— kb seam 恰好支持的那些迁移：晋升待核/引用池（个人）、复核通过/不通过（团队 pending）、归档（团队 ready/revived）、复活（团队 archived）。每个动作都走 `kbWorkbench` Remote namespace——它执行 `ctx.kb` 操作并向工作台所在 session 自己的日志追加与工具相同的 `kb/promote` 事件。
- **内容编辑** —— 卡片详情的"编辑"按钮打开内容字段表单（类型 / 标题 / 适用条件 / 核心结论 / 应做 / 不应做 / 反例 / 来源 / 责任人 / 有效期 / 标签）。保存时携带详情读取时的 mtime/size 文件身份，并发修改会带冲突信息大声失败并保持表单打开；团队卡编辑在默认 `teamWriteApproval` 下需显式确认（approved）。成功后主机追加 `kb/edit` 并刷新详情与 overview。

## Data and mutation flow

所有数据都经由生成的 `kbWorkbench` Remote namespace（由 `@deepseek-ai/dsh-api-remotes` 客户端装配挂载）；组件不持有服务访问与本地状态机。工作区选择器挑一个 `cwd` 能服务工作台的 session；主机侧从该 session 推导工作区根。

## Model Experience

### 人驱动的 session 事件

#### What the model sees

工作台自身不新增任何模型可见面：它驱动的动作追加与既有工具相同的 `kb/*` 事件，因此人的动作与工具调用一样可从 session 日志重建。工作台动作执行迁移时追加携带迁移载荷的 `kb/promote`；被拒的复核不追加，与 `kb_review` 完全一致。内容编辑追加携带变更字段名的 `kb/edit`（卡片文件仍是内容唯一事实源）；无任何变更的编辑不追加。看板数字是 `kb/*` 事件及其持久化文件（热度账本、复盘检查点、卡片文件）的投影。

#### Token effect

除模型本就读的 session 日志内容外无额外开销；工作台不渲染任何 prompt 内容。

#### KV Cache effect

仅追加；工作台驱动的事件与其他 session 事件一样跟在可复用请求前缀之后。

## Known Limitations and Deferred Work

- **可选组合** —— kb-core、kb-web 与本插件通过部署自己的 `cordis.yml` 挂载；出厂 `dsh-web-app` bundle 不含 kb。
- **团队编辑就地确认** —— 团队卡编辑表单渲染显式的"写入团队共享知识库"确认，即主机门禁要求的 `approved` 信号；没有独立审批对话框。
- **一个工作区一个 session** —— 选择器列出带工作区根的 session；没有 session 的工作区无法服务工作台。
- **错误就地呈现** —— Remote 失败渲染在 section 的告警行并带重试；没有 toast 或通知渠道（IM 通知后置）。
